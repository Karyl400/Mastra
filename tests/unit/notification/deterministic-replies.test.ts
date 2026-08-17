/**
 * Le miroir entre les court-circuits et le rationnement ne peut plus diverger — vérifions-le.
 *
 * Ces huit cas vivaient à DEUX endroits du handler : la suite de `if` de `handleMessage` et
 * `isAnsweredWithoutModel`, dont le commentaire d'origine exigeait qu'il en soit « le MIROIR
 * EXACT ». Un court-circuit ajouté d'un seul côté fait rationner un message gratuit — c'est
 * exactement le défaut trouvé en production, où quelqu'un ayant atteint son quota recevait
 * « J'ai atteint mon quota » pour un simple « bonjour ».
 */
import { describe, it, expect } from 'vitest';
import {
  DETERMINISTIC_REPLIES,
  FILE_SHARE_SUBTYPE,
  findStaticReply,
  isAnsweredWithoutModel,
} from '../../../src/features/notification/domain/services/deterministic-replies';

describe('court-circuits déterministes — la table est la source unique', () => {
  it('énumère les huit cas documentés, dans leur ordre contractuel', () => {
    expect(DETERMINISTIC_REPLIES.map((entry) => entry.name)).toEqual([
      'bare_greeting',
      'file_attachment',
      'no_textual_content',
      'over_length',
      'distress',
      'erasure_request',
      'pin_fact',
      'profile_form_request',
    ]);
  });

  it('place TOUTES les réponses figées avant les court-circuits qui agissent', () => {
    // C'est ce qui rend `findStaticReply` équivalent à l'ordre d'évaluation d'origine :
    // balayer les entrées figées d'abord ne peut pas court-circuiter une entrée agissante
    // qui serait arrivée avant. Si quelqu'un insère demain une réponse figée APRÈS
    // `erasure_request`, ce test tombe et la mise en garde de `findStaticReply` devient
    // fausse — c'est précisément ce qu'on veut attraper.
    const firstActing = DETERMINISTIC_REPLIES.findIndex((entry) => entry.reply === null);
    const lastStatic = DETERMINISTIC_REPLIES.map((e) => e.reply !== null).lastIndexOf(true);
    expect(lastStatic).toBeLessThan(firstActing);
  });

  it.each([
    ['bonjour', 'bare_greeting'],
    ['🎉🎉🎉', 'no_textual_content'],
    ['x'.repeat(9000), 'over_length'],
  ])('« %s » emprunte le court-circuit %s', (text, expected) => {
    expect(findStaticReply({ text })?.name).toBe(expected);
  });

  it('reconnaît la pièce jointe par son sous-type, pas par son texte', () => {
    expect(findStaticReply({ text: 'voici', subtype: FILE_SHARE_SUBTYPE })?.name).toBe(
      'file_attachment',
    );
    expect(findStaticReply({ text: 'voici' })).toBeUndefined();
  });

  it('ne court-circuite pas une demande ordinaire', () => {
    const ordinaire = { text: "retrouve l'employé dont l'email est a@b.com" };
    expect(findStaticReply(ordinaire)).toBeUndefined();
    expect(isAnsweredWithoutModel(ordinaire)).toBe(false);
  });

  it('DÉRIVE le rationnement de la table — les huit cas y sont couverts', () => {
    // L'invariant qui compte : tout ce que la table reconnaît est gratuit. Le vérifier
    // entrée par entrée plutôt que sur une liste recopiée est justement le point du module.
    const payloads: Record<string, { text: string; subtype?: string }> = {
      bare_greeting: { text: 'bonjour' },
      file_attachment: { text: '', subtype: FILE_SHARE_SUBTYPE },
      no_textual_content: { text: '👍' },
      over_length: { text: 'x'.repeat(9000) },
      distress: { text: 'je ne vais pas bien du tout, je suis au bout' },
      erasure_request: { text: "oublie ce que je t'ai dit" },
      pin_fact: { text: 'souviens-toi que je suis basé à Lagos' },
      profile_form_request: { text: 'je veux compléter mon profil' },
    };

    // Aucune entrée de la table ne doit être sans charge d'essai : sinon un ajout futur
    // passerait ce test sans être exercé.
    expect(Object.keys(payloads).sort()).toEqual(DETERMINISTIC_REPLIES.map((e) => e.name).sort());

    for (const entry of DETERMINISTIC_REPLIES) {
      const payload = payloads[entry.name];
      expect(entry.matches(payload), `${entry.name} doit reconnaître sa charge`).toBe(true);
      expect(isAnsweredWithoutModel(payload), `${entry.name} doit être gratuit`).toBe(true);
    }
  });

  it("n'attribue `remembersTurn` qu'à la salutation", () => {
    // Sans elle, un fil ouvert par « bonjour » ne serait jamais « engagé » et
    // `shouldAbandonThreadReply` écarterait le message SUIVANT. Partout ailleurs c'est
    // délibérément faux — une confidence de détresse en particulier n'a pas à être rejouée
    // à chaque tour.
    const remembering = DETERMINISTIC_REPLIES.filter((entry) => entry.remembersTurn);
    expect(remembering.map((entry) => entry.name)).toEqual(['bare_greeting']);
  });
});
