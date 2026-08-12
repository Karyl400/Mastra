import { logger } from '../../../../shared/logger';
import {
  resolveAccess,
  readOrgEmailDomains,
  type AccessDecision,
  type AccessLevel,
  type AccessPolicyConfig,
  type AccessSubject,
} from '../../domain/services/access-policy';

/**
 * LE POINT D'APPLICATION de la frontière d'autorisation (P1).
 *
 * `access-policy.ts` dit ce qui *devrait* se passer. Ce fichier dit ce qui se passe
 * *réellement* — et les deux sont délibérément séparés, parce que c'est cette séparation qui
 * rend le déploiement sûr.
 *
 * ----------------------------------------------------------------------------
 * LE MODE OBSERVATION N'EST PAS UNE PRÉCAUTION DE STYLE
 * ----------------------------------------------------------------------------
 * `COMPETENCES_ET_ANALYSE.md` P1 chiffre le risque d'introduction ainsi : « Faible côté code.
 * **Réel côté exploitation** : une allowlist mal peuplée bloque les utilisateurs légitimes. »
 * Le remède qu'il prescrit est repris ici tel quel — journaliser ce qui SERAIT refusé, sans
 * rien refuser, lire les logs, puis activer.
 *
 * La propriété qui compte : la décision est calculée à l'identique dans les deux modes. Le
 * mode observation ne court-circuite pas la politique, il court-circuite son APPLICATION.
 * Sans quoi les journaux qu'on relit avant d'activer décriraient un code différent de celui
 * qu'on activerait — et l'on n'aurait rien mesuré du tout.
 *
 * ----------------------------------------------------------------------------
 * ⚠️ ACTIVER SANS CONFIGURER NE PEUT PAS ARRIVER
 * ----------------------------------------------------------------------------
 * `AUTHZ_ENFORCE=true` avec `SLACK_ORG_EMAIL_DOMAINS` vide donnerait `readonly` à TOUT LE
 * MONDE : la politique, correctement, n'accorde `full` à personne quand elle ne sait pas ce
 * qu'est un domaine interne. Appliquer cela rétrograderait l'organisation entière sur une
 * variable oubliée, et le symptôme (« le bot ne sait plus rien faire ») ne désignerait pas sa
 * cause. On refuse donc d'appliquer, on journalise en `error`, et on reste en observation.
 *
 * C'est la même doctrine que `checkTeamId` : fail-open, mais BRUYANT. Ce dépôt a déjà payé le
 * prix des échecs silencieux trois fois — `emailSent: false` sous `status: 'success'`,
 * `documents.content` perdu sans erreur, `status = Sent` posé avant l'envoi.
 */

export interface AccessEvaluation {
  /** Ce que la politique décide — toujours calculé, même en observation. */
  readonly decision: AccessDecision;
  /** Ce qui est réellement appliqué. En observation, toujours `full`. */
  readonly effective: AccessLevel;
  /** `false` en observation, ou quand la configuration interdit d'appliquer. */
  readonly enforced: boolean;
}

/** Résout le sujet d'une décision. `null` = inconnu de l'annuaire. */
export type SubjectResolver = (slackUserId: string) => Promise<AccessSubject | null>;

export interface SlackAccessGuardOptions {
  readonly resolveSubject: SubjectResolver;
  readonly policy?: AccessPolicyConfig;
  readonly enforce?: boolean;
}

/** Lit `AUTHZ_ENFORCE`. Tout ce qui n'est pas explicitement « vrai » vaut observation. */
export function readAuthzEnforce(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

export class SlackAccessGuard {
  private readonly resolveSubject: SubjectResolver;
  private readonly policy: AccessPolicyConfig;
  private readonly enforceRequested: boolean;
  /** Un avertissement de configuration, pas un par message. */
  private misconfigurationLogged = false;

  constructor(options: SlackAccessGuardOptions) {
    this.resolveSubject = options.resolveSubject;
    this.policy = options.policy ?? {
      orgEmailDomains: readOrgEmailDomains(process.env.SLACK_ORG_EMAIL_DOMAINS),
    };
    this.enforceRequested = options.enforce ?? readAuthzEnforce(process.env.AUTHZ_ENFORCE);
  }

  /**
   * Évalue l'accès d'une personne.
   *
   * NE LÈVE JAMAIS. Une panne de l'annuaire ne doit pas devenir une panne du bot : le sujet
   * devient `null`, donc `unknown_actor`, donc `readonly` — la réponse monotone restrictive.
   * C'est aussi pourquoi `unknown_actor` ne vaut pas refus : un événement parvenu jusqu'ici a
   * déjà franchi la signature HMAC et le contrôle de `team_id`, son origine n'est pas en
   * doute ; seul son privilège l'est.
   */
  async evaluate(slackUserId: string): Promise<AccessEvaluation> {
    let subject: AccessSubject | null = null;

    try {
      subject = await this.resolveSubject(slackUserId);
    } catch (error) {
      logger.warn('Directory lookup failed — treating the actor as unknown', {
        slackUserId,
        error,
      });
    }

    const decision = resolveAccess(subject, this.policy);
    const enforced = this.canEnforce();

    if (!enforced && decision.level !== 'full') {
      // LA ligne à lire avant d'activer. Elle répond exactement à la question qu'on se pose
      // à ce moment-là : « qui perdrait quoi, et pourquoi ? »
      logger.info('Authorization (observation mode) — this actor WOULD be restricted', {
        slackUserId,
        wouldBe: decision.level,
        reason: decision.reason,
      });
    }

    if (enforced && decision.level !== 'full') {
      logger.warn('Authorization enforced — actor restricted', {
        slackUserId,
        level: decision.level,
        reason: decision.reason,
      });
    }

    return {
      decision,
      effective: enforced ? decision.level : 'full',
      enforced,
    };
  }

  /**
   * Applique-t-on réellement ? Non si la politique n'a pas de domaine déclaré — voir
   * l'avertissement en tête de fichier.
   */
  private canEnforce(): boolean {
    if (!this.enforceRequested) return false;

    if (this.policy.orgEmailDomains.length === 0) {
      if (!this.misconfigurationLogged) {
        this.misconfigurationLogged = true;
        logger.error(
          'AUTHZ_ENFORCE is on but SLACK_ORG_EMAIL_DOMAINS is empty — refusing to enforce, ' +
            'which would downgrade the entire organization. Staying in observation mode.',
        );
      }
      return false;
    }

    return true;
  }
}
