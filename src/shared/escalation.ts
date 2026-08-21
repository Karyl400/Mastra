/**
 * ⚠️ « L'ÉQUIPE RH » N'EXISTE PAS DANS CETTE ENTREPRISE — c'était une promesse creuse de plus.
 *
 * Six textes en dur renvoyaient vers « l'équipe RH » : deux dans l'onboarding, deux dans
 * l'effacement, un dans un `hint` d'outil, un dans le message de détresse. Aucun de ces
 * renvois ne désignait quelqu'un de joignable. Le relevé de production du 2026-08-20 est
 * sans ambiguïté : le workspace compte SEPT personnes, dont UNE seule porte
 * `slack_directory.role = 'manager'` — le General Manager. Il n'y a pas de service RH.
 *
 * C'est la même famille de défaut que le 3114 français dans le message de détresse, que
 * `emailSent: false` sous `status: 'success'`, et que les cinq tâches d'onboarding qu'aucun
 * mécanisme ne faisait avancer : le produit nommait une instance qui n'existe pas, et la
 * personne à qui on le disait n'avait aucun moyen de s'en apercevoir.
 *
 * ⚠️ DÉCLARÉ ICI UNE SEULE FOIS, jamais recopié. Six littéraux se désynchronisent au premier
 * changement de personne — et le symptôme serait qu'on continue d'orienter les gens vers
 * quelqu'un qui a quitté l'entreprise. Ce dépôt a déjà eu des instructions qui nommaient
 * `discoverSlackWorkspace` et `createEmployee` longtemps après leur retrait.
 *
 * ⚠️ CE N'EST PAS UNE FRONTIÈRE D'AUTORISATION. Le droit de lire un dossier se décide sur
 * `slack_directory.role`, en base, par `resolveAccess` — jamais sur cette chaîne. Ici on
 * nomme quelqu'un dans une phrase ; là-bas on accorde un droit. Les confondre ferait qu'un
 * renommage de courtoisie changerait qui peut lire quoi.
 */

const DEFAULT_ESCALATION_NAME = 'Nazer';
const DEFAULT_ESCALATION_ROLE = 'General Manager';

export function escalationName(env: NodeJS.ProcessEnv = process.env): string {
  return env.ESCALATION_CONTACT_NAME?.trim() || DEFAULT_ESCALATION_NAME;
}

export function escalationRole(env: NodeJS.ProcessEnv = process.env): string {
  return env.ESCALATION_CONTACT_ROLE?.trim() || DEFAULT_ESCALATION_ROLE;
}

/** « Nazer, le General Manager » — la forme employée dans une phrase française. */
export const ESCALATION_CONTACT = `${escalationName()}, le ${escalationRole()}`;

/** « Nazer, the General Manager » — même personne, phrase anglaise. */
export const ESCALATION_CONTACT_EN = `${escalationName()}, the ${escalationRole()}`;
