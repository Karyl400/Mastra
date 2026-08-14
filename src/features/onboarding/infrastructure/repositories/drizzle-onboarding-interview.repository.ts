import { eq } from 'drizzle-orm';
import { getDb } from '../../../../infrastructure/database/connection';
import { onboardingInterview } from '../../../../infrastructure/database/schema';
import type {
  OnboardingInterview,
  OnboardingInterviewRepository,
} from '../../domain/ports/onboarding-interview.repository';

/**
 * Persistance de l'entretien post-profil sur LibSQL/Turso.
 *
 * ⚠️ La table `onboarding_interview` n'est PAS créée par les migrations `drizzle/` : celles-ci
 * sont désynchronisées de `schema.ts`, et `drizzle-kit push` se bloque indéfiniment contre une
 * base `libsql://` distante. Le DDL vit dans `scripts/ddl-onboarding-interview.sql` et doit
 * être appliqué AVANT le déploiement.
 */
export class DrizzleOnboardingInterviewRepository implements OnboardingInterviewRepository {
  async findByEmployee(employeeId: string): Promise<OnboardingInterview | null> {
    const db = getDb();
    const row = await db
      .select()
      .from(onboardingInterview)
      .where(eq(onboardingInterview.employeeId, employeeId))
      .get();

    return row ? toDomain(row) : null;
  }

  /**
   * ⚠️ Le `set` de l'upsert énumère les champs UN À UN, et `createdAt` en est ABSENT.
   *
   * Ce n'est pas de la verbosité : `set: interview` réécrirait `created_at` à chaque
   * correction, donc la date du premier entretien serait perdue au premier changement d'avis.
   * Même invariant que `first_seen_at` de `slack_directory`, même mode d'échec évité — une
   * perte muette, du genre de celle qui a coûté `documents.content` sur 6 lignes sur 6.
   */
  async save(interview: OnboardingInterview): Promise<void> {
    const db = getDb();

    await db
      .insert(onboardingInterview)
      .values({
        employeeId: interview.employeeId,
        slackUserId: interview.slackUserId,
        channels: interview.channels,
        dailyWork: interview.dailyWork,
        workStyle: interview.workStyle,
        createdAt: interview.createdAt,
        updatedAt: interview.updatedAt,
      })
      .onConflictDoUpdate({
        target: onboardingInterview.employeeId,
        set: {
          slackUserId: interview.slackUserId,
          channels: interview.channels,
          dailyWork: interview.dailyWork,
          workStyle: interview.workStyle,
          updatedAt: interview.updatedAt,
        },
      });
  }
}

function toDomain(row: typeof onboardingInterview.$inferSelect): OnboardingInterview {
  return {
    employeeId: row.employeeId,
    slackUserId: row.slackUserId,
    // La colonne est du JSON libre côté pilote : on ne fait CONFIANCE ni à sa forme ni à son
    // contenu. Une ligne écrite par une version antérieure, ou à la main, ne doit pas faire
    // lever un `.map()` sur `undefined` au milieu d'une génération de document.
    channels: Array.isArray(row.channels) ? (row.channels as string[]).filter(isChannelId) : [],
    dailyWork: row.dailyWork ?? '',
    workStyle: row.workStyle ?? '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Un identifiant de canal Slack, et rien d'autre — il finit dans `conversations.invite`. */
function isChannelId(value: unknown): value is string {
  return typeof value === 'string' && /^[CG][A-Z0-9]{2,}$/.test(value);
}
