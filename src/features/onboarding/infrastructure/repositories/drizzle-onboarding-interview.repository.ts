import { eq } from 'drizzle-orm';
import { getDb } from '../../../../infrastructure/database/connection';
import { onboardingInterview } from '../../../../infrastructure/database/schema';
import type {
  OnboardingInterview,
  OnboardingInterviewRepository,
} from '../../domain/ports/onboarding-interview.repository';

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

  async findAll(): Promise<OnboardingInterview[]> {
    const db = getDb();
    const rows = await db.select().from(onboardingInterview).all();
    return rows.map(toDomain);
  }

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
    channels: Array.isArray(row.channels) ? (row.channels as string[]).filter(isChannelId) : [],
    dailyWork: row.dailyWork ?? '',
    workStyle: row.workStyle ?? '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isChannelId(value: unknown): value is string {
  return typeof value === 'string' && /^[CG][A-Z0-9]{2,}$/.test(value);
}
