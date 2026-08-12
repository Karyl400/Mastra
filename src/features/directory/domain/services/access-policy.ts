/**
 * LA FRONTIÈRE D'AUTORISATION (P1) — service de domaine PUR.
 *
 * Constat qui a motivé ce fichier : `slack-events.handler.ts` lisait `event.user` pour le
 * journal et l'anti-boucle, puis le jetait. Aucune allowlist, aucun rôle, aucune vérification
 * d'appartenance. Tous les outils à effet de bord — `createEmployee`, `updateOnboardingStatus`,
 * `generateDocument`, `generateQuestionnaire`, `sendNotification`, `scheduleReminder` — étaient
 * donc atteignables par n'importe quel membre du workspace, invité externe compris, et par
 * n'importe quel texte qui traversait le routage.
 *
 * ----------------------------------------------------------------------------
 * POURQUOI CETTE DÉCISION EST PRISE EN CODE, ET NON PAR UN MODÈLE
 * ----------------------------------------------------------------------------
 * `PLAN-ARCHITECTURE.md` §3.1 le formule mieux qu'on ne le referait ici : un garde-fou
 * déterministe échoue OUVERT MAIS SILENCIEUX (le texte passe et reste étiqueté non fiable),
 * là où un garde-fou LLM échoue OUVERT ET BRUYANT (le texte passe *et devient attesté
 * conforme*). Une décision d'autorisation prise par un modèle sur une entrée adverse n'est pas
 * une autorisation. D'où une fonction pure, totale, sans E/S et sans dépendance : elle se lit,
 * se teste exhaustivement, et ne se laisse pas convaincre.
 *
 * ----------------------------------------------------------------------------
 * POURQUOI LA RÈGLE EST DÉRIVÉE, ET NON ÉCRITE À LA MAIN
 * ----------------------------------------------------------------------------
 * `COMPETENCES_ET_ANALYSE.md` P1 proposait `SLACK_ADMIN_USER_IDS=U1,U2,…`. Écarté. Ce dépôt a
 * déjà payé trois fois le prix d'une liste tenue à la main qui se désynchronise du réel : des
 * instructions d'agent nommant `discoverSlackWorkspace` et `createEmployee` longtemps après
 * leur retrait, la constante `WIRING` d'un test de budget, et `_measure.mts`. C'est la raison
 * pour laquelle `agentToolBoundary(tools)` dérive de `Object.keys(tools)` plutôt que d'une
 * énumération rédigée — même exigence ici.
 *
 * La règle porte donc sur des faits que Slack maintient lui-même : `is_bot`, `is_restricted`,
 * `is_ultra_restricted`, `deleted`, et le domaine de l'adresse professionnelle. Ajouter un
 * invité au workspace le rétrograde AUTOMATIQUEMENT, sans qu'aucune variable d'environnement
 * n'ait à être touchée ni qu'aucun humain n'ait à y penser.
 *
 * ----------------------------------------------------------------------------
 * CE QUE CE MODULE NE FAIT PAS
 * ----------------------------------------------------------------------------
 * Il n'implémente PAS le RBAC Employé / RH / Manager annoncé par `CONTEXT.md`. Trois niveaux,
 * pas davantage : c'est le découpage que les capacités réelles du système savent honorer
 * aujourd'hui. Inventer un palier « RH » sans tool qui en dépende produirait exactement le
 * défaut que ce dépôt combat — un composant enregistré qui promet plus qu'il ne tient. Le RBAC
 * complet est P10, et il dépend d'abord de la circulation de l'identité jusqu'aux tools.
 *
 * Il ne DÉCIDE pas non plus si la décision est appliquée : le mode observation vit chez
 * l'appelant. Cette fonction dit ce qui *devrait* se passer, toujours, même quand rien n'est
 * appliqué — c'est ce qui rend le mode observation mesurable.
 */

/**
 * Trois niveaux, ordonnés du plus restrictif au plus permissif.
 *
 *  - `denied`   : l'événement n'est pas traité du tout. Aucun appel LLM, aucun tool.
 *  - `readonly` : traité, mais par un agent dépourvu de tout outil à effet de bord.
 *  - `full`     : traité par l'agent nominal.
 */
export type AccessLevel = 'denied' | 'readonly' | 'full';

/**
 * Motif de la décision. Il est journalisé et sert le mode observation — c'est lui qui répond à
 * « qu'est-ce qui serait refusé si on activait ? ». Jamais montré à l'utilisateur : nommer la
 * règle qui a porté renseignerait un attaquant sur la sonde qui a fonctionné, exactement le
 * défaut corrigé sur `[SECURITY_BLOCK]`.
 */
export type AccessReason =
  | 'org_member'
  | 'guest'
  | 'no_email'
  | 'foreign_domain'
  | 'unknown_actor'
  | 'policy_not_configured'
  | 'bot_actor'
  | 'deactivated_account';

export interface AccessDecision {
  readonly level: AccessLevel;
  readonly reason: AccessReason;
}

/**
 * Le sujet de la décision — la personne, telle que l'annuaire la connaît.
 *
 * Volontairement RÉDUIT aux champs qui portent une conséquence d'autorisation. `isAdmin` est
 * collecté par l'annuaire mais absent d'ici : aucun palier ne l'utilise aujourd'hui, et un
 * champ présent dans une signature de sécurité finit toujours par être lu comme s'il faisait
 * quelque chose.
 */
export interface AccessSubject {
  readonly slackUserId: string;
  readonly email: string | null;
  readonly isBot: boolean;
  /** Invité multi-canal (`is_restricted` chez Slack). */
  readonly isRestricted: boolean;
  /** Invité mono-canal (`is_ultra_restricted` chez Slack). */
  readonly isUltraRestricted: boolean;
  readonly isDeleted: boolean;
}

export interface AccessPolicyConfig {
  /**
   * Domaines email de l'organisation, en minuscules et sans `@`.
   *
   * Vide = politique non configurée : personne n'obtient `full`. Une absence de configuration
   * ne se lit pas « tout le monde est de la maison » — ce serait fabriquer un privilège à
   * partir d'un oubli.
   */
  readonly orgEmailDomains: readonly string[];
}

/** Lit `SLACK_ORG_EMAIL_DOMAINS` (`kissohq.com,exemple.fr`). */
export function readOrgEmailDomains(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

/**
 * Extrait le domaine d'une adresse, ou `null` si l'adresse n'en porte pas un exploitable.
 *
 * On prend la partie après le DERNIER `@` : `"a@b"@evil.com` est une adresse syntaxiquement
 * valide dont le domaine réel est `evil.com`, et découper sur le premier `@` rendrait ici
 * `b"@evil.com` — une chaîne qui ne correspond à rien et pourrait, selon la comparaison,
 * passer pour un domaine interne.
 */
function extractDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/**
 * `true` si le domaine EST un domaine de l'organisation ou un de ses sous-domaines.
 *
 * ⚠️ Le point du `.` n'est pas cosmétique. Un `domain.endsWith(org)` nu accorderait `full` à
 * `notkissohq.com`, que n'importe qui enregistre pour quelques euros. On exige donc soit
 * l'égalité stricte, soit une frontière de label — `mail.kissohq.com` passe, `notkissohq.com`
 * non. C'est le même défaut de classe que celui corrigé sur le routage par mots-clés, où
 * `String.includes('test')` capturait « contestation ».
 */
function belongsToOrg(domain: string, orgDomains: readonly string[]): boolean {
  return orgDomains.some((org) => domain === org || domain.endsWith(`.${org}`));
}

/**
 * Décide du niveau d'accès. Fonction TOTALE : tout sujet, y compris `null`, reçoit une
 * décision — il n'existe pas d'entrée pour laquelle l'appelant aurait à inventer un défaut.
 *
 * L'ORDRE DES RÈGLES EST LE FOND DU CORRECTIF, pas un détail de lecture :
 *
 *   1. Les refus durs d'abord (bot, compte désactivé) — ils ne se négocient contre rien.
 *   2. Le statut d'invité AVANT le domaine. L'inverse rendrait `full` à un invité porteur
 *      d'une adresse interne, c'est-à-dire précisément au cas que ce contrôle vise.
 *   3. Le domaine en dernier — la seule règle qui puisse ACCORDER quelque chose.
 *
 * Un sujet inconnu (`null`) est rétrogradé, jamais refusé : voir le test correspondant.
 */
export function resolveAccess(
  subject: AccessSubject | null,
  policy: AccessPolicyConfig,
): AccessDecision {
  if (!subject) return { level: 'readonly', reason: 'unknown_actor' };

  if (subject.isBot) return { level: 'denied', reason: 'bot_actor' };
  if (subject.isDeleted) return { level: 'denied', reason: 'deactivated_account' };

  if (subject.isRestricted || subject.isUltraRestricted) {
    return { level: 'readonly', reason: 'guest' };
  }

  if (policy.orgEmailDomains.length === 0) {
    return { level: 'readonly', reason: 'policy_not_configured' };
  }

  const email = subject.email?.trim().toLowerCase();
  if (!email) return { level: 'readonly', reason: 'no_email' };

  const domain = extractDomain(email);
  if (!domain) return { level: 'readonly', reason: 'no_email' };

  return belongsToOrg(domain, policy.orgEmailDomains)
    ? { level: 'full', reason: 'org_member' }
    : { level: 'readonly', reason: 'foreign_domain' };
}
