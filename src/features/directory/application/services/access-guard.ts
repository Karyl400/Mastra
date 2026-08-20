import { logger } from '../../../../shared/logger';
import {
  resolveAccess,
  type AccessDecision,
  type AccessLevel,
  type AccessSubject,
} from '../../domain/services/access-policy';

export interface AccessEvaluation {
  readonly decision: AccessDecision;
  readonly effective: AccessLevel;
  readonly enforced: boolean;
}

export type SubjectResolver = (slackUserId: string) => Promise<AccessSubject | null>;

export interface SlackAccessGuardOptions {
  readonly resolveSubject: SubjectResolver;
  readonly enforce?: boolean;
  readonly hasManager?: () => Promise<boolean>;
}

const MANAGER_RECHECK_MS = 60_000;

export function readAuthzEnforce(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

export class SlackAccessGuard {
  private readonly resolveSubject: SubjectResolver;
  private readonly enforceRequested: boolean;
  private readonly hasManager?: () => Promise<boolean>;
  private misconfigurationLogged = false;
  private managerSeen = false;
  private lastManagerCheck = 0;

  constructor(options: SlackAccessGuardOptions) {
    this.resolveSubject = options.resolveSubject;
    this.enforceRequested = options.enforce ?? readAuthzEnforce(process.env.AUTHZ_ENFORCE);
    this.hasManager = options.hasManager;
  }

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

    const decision = resolveAccess(subject);
    const enforced = await this.canEnforce();

    if (!enforced && decision.level !== 'full') {
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

  private async canEnforce(): Promise<boolean> {
    if (!this.enforceRequested) return false;

    if (!this.hasManager) {
      this.warnOnce(
        'AUTHZ_ENFORCE is on but the guard was built without a way to check for a manager — ' +
          'refusing to enforce. Staying in observation mode.',
      );
      return false;
    }

    if (this.managerSeen) return true;

    const now = Date.now();
    if (now - this.lastManagerCheck < MANAGER_RECHECK_MS) return false;
    this.lastManagerCheck = now;

    const found = await this.hasManager().catch((error) => {
      logger.warn('Could not check whether a manager exists — staying in observation mode', {
        error,
      });
      return false;
    });

    if (!found) {
      this.warnOnce(
        'AUTHZ_ENFORCE is on but NO employee carries the manager role — refusing to enforce, ' +
          'which would downgrade the entire organization. Designate one with `npm run role:set`.',
      );
      return false;
    }

    this.managerSeen = true;
    return true;
  }

  private warnOnce(message: string): void {
    if (this.misconfigurationLogged) return;
    this.misconfigurationLogged = true;
    logger.error(message);
  }
}
