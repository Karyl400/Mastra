import { describe, it, expect } from 'vitest';

import { AGENT_TOOLS } from '../../../src/shared/agent-capabilities';

/**
 * INVARIANT — un agent à qui l'on peut parler d'une personne doit pouvoir la CHERCHER.
 *
 * `AGENT_ANTI_INVENTION_BLOCK` ordonne déjà : « n'invente aucune donnée absente (nom, email,
 * identifiant, date, URL, lien, chemin) : cherche-la avec un tool ou demande-la ». La règle
 * était donc écrite. Ce qui manquait, c'est qu'un agent puisse lui OBÉIR.
 *
 * Relevé le 2026-08-20 : `knowledgeAgent` ne portait ni `findPersonByName` ni
 * `findEmployeeByEmail`. Interrogé sur quelqu'un — ce qui est le cas nominal d'un agent de
 * connaissance — il n'avait aucun moyen de résoudre l'identité, et la seule issue restante
 * était l'invention. C'est la répétition exacte du défaut du 2026-08-10, où la recherche par
 * email était structurellement inatteignable, et de celui du 2026-08-14 qui a mis
 * `findExpertise` sur trois agents.
 *
 * Ce test est DÉRIVÉ de `AGENT_TOOLS`, jamais rédigé : déplacer un outil d'un agent à l'autre
 * le fait rougir tout seul. Une liste écrite à la main se désynchronise au premier changement
 * de câblage — ce dépôt l'a payé trois fois.
 */

/** Outils qui rendent une identité de personne exploitable par les autres. */
const PERSON_RESOLUTION = ['findPersonByName', 'findEmployeeByEmail'];

/**
 * Outils dont l'usage porte SUR une personne : les câbler sans moyen de résoudre l'identité,
 * c'est demander au modèle de produire un identifiant qu'il ne peut qu'inventer.
 */
const PERSON_SCOPED = [
  'getEmployeeProfile',
  'getNotificationHistory',
  'generateDocument',
  'sendNotification',
  'scheduleReminder',
  'updateOnboardingStatus',
  'findExpertise',
  'getUserConversations',
];

describe('capacité de résolution de personne', () => {
  const agents = Object.entries(AGENT_TOOLS);

  it.each(agents)(
    '%s — porte de quoi résoudre une personne s’il parle de personnes',
    (id, tools) => {
      const parleDePersonnes = tools.some((t) => PERSON_SCOPED.includes(t));
      if (!parleDePersonnes) return;

      expect(
        tools.some((t) => PERSON_RESOLUTION.includes(t)),
        `${id} porte ${tools.filter((t) => PERSON_SCOPED.includes(t)).join(', ')} mais aucun outil ` +
          `de résolution : il ne peut obtenir un identifiant qu'en l'inventant.`,
      ).toBe(true);
    },
  );

  it('recruitmentAgent reste SANS aucun outil de lecture — quarantaine §4.2', () => {
    // ⚠️ L'exception, et elle est délibérée. `makeRecruitmentAgent` LÈVE au démarrage si on
    // lui câble un outil dont le nom commence par find|get|list|read|search : il porte une
    // écriture EXTERNE (email à un candidat), et la conjonction lecture agrégée + écriture
    // externe est le canal d'exfiltration que `outbound-tool-quarantine.ts` §4.2 interdit.
    //
    // Il n'en a pas besoin : son schéma prend des champs explicites, et le corps de l'email
    // est rendu par un GABARIT. Le pire cas d'une injection réussie y est un spam
    // d'invitation, jamais une fuite — il n'y a rien à exfiltrer par ce chemin.
    expect(AGENT_TOOLS.recruitmentAgent.some((t) => /^(find|get|list|read|search)/.test(t))).toBe(
      false,
    );
  });
});
