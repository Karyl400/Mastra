/**
 * L'EMAIL DE BIENVENUE — ce qu'on sait de la personne, et RIEN d'autre.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Les deux défauts corrigés le 2026-08-14
 * ════════════════════════════════════════════════════════════════════════════
 *
 * **1. Il PROMETTAIT ce qu'aucun mécanisme ne tient.** Le texte disait, mot pour mot :
 *
 * > « Vous recevrez prochainement les accès à nos outils ainsi que votre planning de première
 * > semaine. »
 *
 * Il n'existe **aucun provisioning de comptes** et **aucun planning** dans ce système — ni
 * cron, ni workflow, ni tool. Vérifié : les seules occurrences de ces mots dans `src/` sont
 * cette phrase elle-même. C'est le tout premier message que l'entreprise adresse à un
 * arrivant, et il ouvre sur une promesse qui ne sera pas tenue. Même famille que
 * `emailSent: false` sous `status: 'success'`, que les cinq tâches qu'aucun mécanisme ne
 * faisait avancer, et que le `status: Scheduled` d'un rappel que rien ne reprend.
 *
 * **2. Il était GÉNÉRIQUE alors que la donnée existait.** `position` et `startDate` sont
 * saisis dans la modale, portés par `employeeCreatedSchema`… puis **jetés** au passage de
 * `onboardingInitializedSchema`, deux étapes avant l'email. La personnalisation n'était donc
 * pas absente par choix : elle était perdue en route.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * La règle de ce gabarit
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Chaque phrase repose sur une donnée VÉRIFIÉE, ou n'est pas écrite. Un champ absent fait
 * disparaître sa phrase — il ne déclenche jamais un « N/A », ni une formule de remplissage.
 * C'est la même discipline que `buildWelcomeLetter`, dont on a retiré « Département : N/A »
 * pour cette raison exacte : un intertitre suivi du vide se lit comme un oubli.
 *
 * ⚠️ Le seul énoncé tourné vers l'AVENIR est celui du bouton de profil, et il est vrai : le
 * DM part réellement, et le formulaire existe. On ne parle donc jamais de ce qui « va être
 * envoyé » sans que quelque chose l'envoie.
 *
 * TypeScript pur — ce module traverse la couche `domain`.
 */

export interface WelcomeEmailInput {
  readonly firstName: string;
  readonly lastName: string;
  /** `null` par défaut depuis le 2026-08-13 : le parcours d'arrivée ne le collecte plus. */
  readonly department?: string | null;
  readonly position?: string | null;
  /** ISO. Rendue en toutes lettres, ou omise si illisible — jamais affichée brute. */
  readonly startDate?: string | null;
  /** Canaux Slack où la personne va réellement être invitée. Omis si la liste est vide. */
  readonly channels?: readonly string[];
}

export interface WelcomeEmail {
  readonly subject: string;
  readonly body: string;
}

import { formatFrenchDay } from '../../../../shared/french-date';

const COMPANY = 'Kisso Industries';

export function buildWelcomeEmail(input: WelcomeEmailInput): WelcomeEmail {
  const firstName = input.firstName.trim();

  // ⚠️ DES PHRASES, plus des puces étiquetées. Le bloc disait « Ce que nous avons
  // enregistré : » suivi de « Poste : … », « Équipe : … », « Premier jour : … » — du langage
  // de guichet, et surtout la forme même que le bloc STYLE interdit aux agents (« sans liste
  // numérotée », « pas de plan »). Le gabarit faisait donc ce qu'on refuse au modèle, dans le
  // PREMIER message que l'entreprise adresse à quelqu'un.
  //
  // Chaque fragment reste adossé à une donnée vérifiée, et un champ absent fait disparaître
  // sa mention — c'est la règle du module et elle ne bouge pas.
  const known: string[] = [];
  if (input.position?.trim()) known.push(`comme <strong>${esc(input.position.trim())}</strong>`);
  if (input.department?.trim())
    known.push(`dans l'équipe <strong>${esc(input.department.trim())}</strong>`);

  const day = formatFrenchDay(input.startDate);

  const parts: string[] = [`<p>Bonjour ${esc(firstName)},</p>`];

  // La phrase d'accueil absorbe ce qu'on sait du poste et de l'équipe plutôt que de le
  // reléguer dans une liste : c'est la même information, dite comme un humain la dirait.
  const welcome =
    known.length > 0
      ? `Ravis de t'accueillir chez ${COMPANY} ${known.join(' ')}.`
      : `Ravis de t'accueillir chez ${COMPANY}.`;
  parts.push(`<p>${welcome}</p>`);

  if (day) parts.push(`<p>On t'attend le <strong>${esc(day)}</strong>.</p>`);

  const channels = (input.channels ?? []).map((c) => c.trim()).filter(Boolean);
  if (channels.length > 0) {
    const rendered = channels.map((c) => `<strong>#${esc(c)}</strong>`).join(', ');
    parts.push(`<p>Tu as déjà ta place dans ${rendered}.</p>`);
  }

  // La proposition de correction n'a de sens que si l'on vient d'affirmer quelque chose.
  if (known.length > 0 || day || channels.length > 0) {
    parts.push(
      `<p>Si quelque chose est inexact, dis-le nous — c'est plus simple à corriger maintenant.</p>`,
    );
  }

  // ⚠️ La SEULE projection dans le futur, et elle est vraie : ce DM part réellement, et le
  // formulaire derrière le bouton existe et écrit en base.
  parts.push(
    `<p>Tu vas recevoir un message direct de notre bot sur Slack, avec un bouton pour compléter ton profil. C'est par là que tout commence.</p>`,
    `<p>À très vite,<br/><strong>L'équipe ${COMPANY}</strong></p>`,
  );

  return {
    // Sans point d'exclamation : le bloc STYLE l'interdit au modèle depuis qu'on a mesuré que
    // « les exclamations arrivaient précisément dans les phrases où l'agent ne faisait rien ».
    // Un gabarit n'a pas de raison d'y échapper.
    subject: `Bienvenue chez ${COMPANY}, ${firstName}`,
    body: parts.join(''),
  };
}

/**
 * Le corps est du HTML, et `position` comme `department` viennent d'une saisie humaine dans
 * une modale Slack. Sans échappement, un `<` casserait le rendu — et le dépôt a déjà appris
 * qu'un canal de sortie non filtré finit par porter autre chose que ce qu'on croyait.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
