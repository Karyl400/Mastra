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
 * La règle porte donc sur des faits que le SYSTÈME maintient : `is_bot`, `is_restricted`,
 * `is_ultra_restricted`, `deleted` — que Slack tient à jour — et le RÔLE porté par le dossier
 * employé. Ajouter un invité au workspace le rétrograde AUTOMATIQUEMENT, sans qu'aucune
 * variable d'environnement n'ait à être touchée ni qu'aucun humain n'ait à y penser.
 *
 * ----------------------------------------------------------------------------
 * ⚠️ LE DOMAINE EMAIL N'ACCORDE PLUS RIEN — changement du 2026-08-20
 * ----------------------------------------------------------------------------
 * `full` était accordé à toute adresse dont le domaine figurait dans
 * `SLACK_ORG_EMAIL_DOMAINS`. Deux défauts, et le second est le plus grave :
 *
 *  1. **La portée était collective.** Les six personnes de l'organisation obtenaient la MÊME
 *     portée : chacune pouvait lire le dossier RH des cinq autres. « Membre de la maison » et
 *     « habilité à consulter le dossier de tout le monde » avaient été confondus, alors que
 *     ce sont deux affirmations distinctes — la première ne fonde pas la seconde.
 *  2. **Le fait décisif était contrôlé par le bénéficiaire.** L'adresse vient du profil Slack,
 *     que son porteur édite. Et, mesuré en production, elle rétrogradait l'administratrice de
 *     l'onboarding (adresse `gmail.com`) tout en accordant `full` à trois personnes sans
 *     aucun dossier employé : la frontière refusait celle qui en avait le plus besoin.
 *
 * `full` ⟺ **le demandeur porte le rôle `manager`**. Tous les autres gardent leur PROPRE
 * dossier — `canReadPersonRecord` compare sur `employees.id` AVANT de regarder le niveau, et
 * `canPerformSideEffects` fait désormais de même. `readonly` ne coupe donc personne de
 * soi-même ; il ferme l'accès aux AUTRES.
 *
 * ----------------------------------------------------------------------------
 * CE QUE CE MODULE NE FAIT PAS
 * ----------------------------------------------------------------------------
 * Il n'implémente PAS les TROIS rôles Employé / RH / Manager annoncés par `CONTEXT.md`, mais
 * DEUX. Inventer un palier « RH » sans tool qui en dépende produirait exactement le défaut que
 * ce dépôt combat — un composant enregistré qui promet plus qu'il ne tient. On ajoutera le
 * troisième le jour où un outil saura en faire quelque chose de différent des deux autres.
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
  'manager' | 'not_a_manager' | 'guest' | 'unknown_actor' | 'bot_actor' | 'deactivated_account';

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
  /**
   * Cette personne porte-t-elle le rôle `manager` ?
   *
   * ⚠️ Un BOOLÉEN et non la chaîne brute : ce module est pur, il n'a pas à connaître le
   * vocabulaire de la base. La lecture tolérante — toute valeur inconnue vaut `employee`,
   * jamais `manager` — vit dans `isManagerRole`, au bord où la valeur entre.
   *
   * ⚠️ Il ne dépend d'AUCUN dossier employé, et c'est la donnée réelle qui l'a imposé : le
   * General Manager de cette entreprise n'a pas de ligne dans `employees`, et 5 des 6
   * personnes vivantes non plus. Exiger un dossier aurait rendu la frontière indésignable
   * sans en fabriquer un — c'est-à-dire sans inventer une date d'embauche.
   */
  readonly isManager: boolean;
}

/**
 * Décide du niveau d'accès. Fonction TOTALE : tout sujet, y compris `null`, reçoit une
 * décision — il n'existe pas d'entrée pour laquelle l'appelant aurait à inventer un défaut.
 *
 * L'ORDRE DES RÈGLES EST LE FOND DU CORRECTIF, pas un détail de lecture :
 *
 *   1. Les refus durs d'abord (bot, compte désactivé) — ils ne se négocient contre rien.
 *   2. Le statut d'invité AVANT le rôle. L'inverse accorderait `full` à un invité externe
 *      porteur d'un dossier marqué `manager`, c'est-à-dire précisément au cas que ce contrôle
 *      vise. Le rôle est un fait interne ; l'invitation est un fait de Slack, et c'est celui
 *      qui doit primer.
 *   3. Le rôle en dernier — la seule règle qui puisse ACCORDER quelque chose.
 *
 * Un sujet inconnu (`null`) est rétrogradé, jamais refusé : un événement parvenu jusqu'ici a
 * déjà franchi la signature HMAC et le contrôle de `team_id`, son origine n'est pas en doute ;
 * seul son privilège l'est.
 *
 * ⚠️ `readonly` NE COUPE PERSONNE DE SOI-MÊME. C'est la propriété qui rend cette politique
 * activable : `canReadPersonRecord` et `canPerformSideEffects` comparent sur `employees.id`
 * AVANT de regarder le niveau. Une personne sans dossier ne perd rien non plus — elle n'a
 * rien à perdre. Ce que `readonly` ferme, c'est l'accès aux dossiers des AUTRES.
 */
export function resolveAccess(subject: AccessSubject | null): AccessDecision {
  if (!subject) return { level: 'readonly', reason: 'unknown_actor' };

  if (subject.isBot) return { level: 'denied', reason: 'bot_actor' };
  if (subject.isDeleted) return { level: 'denied', reason: 'deactivated_account' };

  if (subject.isRestricted || subject.isUltraRestricted) {
    return { level: 'readonly', reason: 'guest' };
  }

  return subject.isManager
    ? { level: 'full', reason: 'manager' }
    : { level: 'readonly', reason: 'not_a_manager' };
}
