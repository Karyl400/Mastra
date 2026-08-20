import { logger } from '../../../../shared/logger';
import {
  resolveAccess,
  type AccessDecision,
  type AccessLevel,
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
 * ⚠️ ACTIVER SANS DÉSIGNER DE MANAGER NE PEUT PAS ARRIVER
 * ----------------------------------------------------------------------------
 * `AUTHZ_ENFORCE=true` sans qu'aucun dossier ne porte le rôle `manager` donnerait `readonly` à
 * TOUT LE MONDE : la politique, correctement, n'accorde `full` qu'au manager. Appliquer cela
 * rétrograderait l'organisation entière sur une désignation oubliée, et le symptôme (« le bot
 * ne sait plus rien faire ») ne désignerait pas sa cause. On refuse donc d'appliquer, on
 * journalise en `error`, et on reste en observation.
 *
 * ⚠️ Cette garde portait auparavant sur `SLACK_ORG_EMAIL_DOMAINS` vide. Elle a suivi le fait
 * qui décide : depuis le 2026-08-20 c'est le RÔLE, plus le domaine email. Une garde laissée sur
 * l'ancien fait aurait été strictement décorative — elle aurait laissé passer exactement la
 * panne qu'elle existe pour empêcher, en donnant l'impression contraire.
 * Et l'inversion est ici plus probable qu'avant : la colonne `role` naît VIDE, donc l'état
 * « aucun manager » est l'état de départ, pas un accident.
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
  readonly enforce?: boolean;
  /**
   * « Existe-t-il au moins un dossier portant le rôle `manager` ? »
   *
   * OBLIGATOIRE pour que l'application ait lieu : sans ce moyen de vérifier, on ne peut pas
   * distinguer « la politique est configurée » de « personne n'a été désigné », et le second
   * cas rétrograde tout le monde. Absent ⇒ on reste en observation, bruyamment.
   *
   * NE DOIT JAMAIS LEVER : une panne de lecture n'est pas une preuve d'absence. L'appelant
   * rend `false` en dernier recours, ce qui suspend l'application au lieu de couper l'équipe.
   */
  readonly hasManager?: () => Promise<boolean>;
}

/**
 * Intervalle entre deux vérifications « existe-t-il un manager ? » quand la réponse est NON.
 *
 * Une minute : assez court pour qu'une désignation prenne effet sans redéploiement, assez long
 * pour qu'un état mal configuré ne coûte pas une lecture par message.
 */
const MANAGER_RECHECK_MS = 60_000;

/** Lit `AUTHZ_ENFORCE`. Tout ce qui n'est pas explicitement « vrai » vaut observation. */
export function readAuthzEnforce(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

export class SlackAccessGuard {
  private readonly resolveSubject: SubjectResolver;
  private readonly enforceRequested: boolean;
  private readonly hasManager?: () => Promise<boolean>;
  /** Un avertissement de configuration, pas un par message. */
  private misconfigurationLogged = false;
  /**
   * Mémorisation du contrôle « existe-t-il un manager ? ».
   *
   * ⚠️ ASYMÉTRIQUE, et l'asymétrie est le point. Un `true` est définitif : un manager désigné
   * ne se dé-désigne pas en cours de vie d'instance, et re-vérifier coûterait une lecture par
   * message. Un `false` est RÉÉVALUÉ, avec un intervalle : sans cela, désigner un manager
   * n'aurait d'effet qu'au prochain démarrage à froid, et le diagnostic serait « j'ai fait ce
   * qu'on m'a dit et rien n'a changé » — la classe de panne la plus coûteuse de ce dépôt.
   */
  private managerSeen = false;
  private lastManagerCheck = 0;

  constructor(options: SlackAccessGuardOptions) {
    this.resolveSubject = options.resolveSubject;
    this.enforceRequested = options.enforce ?? readAuthzEnforce(process.env.AUTHZ_ENFORCE);
    this.hasManager = options.hasManager;
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

    const decision = resolveAccess(subject);
    const enforced = await this.canEnforce();

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
   * Applique-t-on réellement ? Non tant qu'aucun manager n'est désigné — voir l'avertissement
   * en tête de fichier.
   */
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

    // Ni `Date.now()` en boucle serrée ni une lecture par message : l'intervalle borne le coût
    // du seul état où ce contrôle échoue, c'est-à-dire un état transitoire de configuration.
    const now = Date.now();
    if (now - this.lastManagerCheck < MANAGER_RECHECK_MS) return false;
    this.lastManagerCheck = now;

    // NE LÈVE PAS : une panne de lecture n'est pas une preuve d'absence, et refuser
    // d'appliquer est le sens le moins coûteux — c'est l'état d'avant l'activation.
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

  /** Un avertissement de configuration pour la vie de l'instance, pas un par message. */
  private warnOnce(message: string): void {
    if (this.misconfigurationLogged) return;
    this.misconfigurationLogged = true;
    logger.error(message);
  }
}
