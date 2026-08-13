import { describe, expect, it } from 'vitest';
import {
  ERASURE_FAILED_REPLY,
  ERASURE_SCOPE_NOTICE,
  erasureDoneReply,
  requestsErasure,
} from '../../../src/shared/forget';

describe("requestsErasure — reconnaissance d'une demande d'effacement", () => {
  it('reconnaît les formulations directes', () => {
    const asked = [
      "oublie ce que je t'ai dit",
      'oublie ce que je t ai dit',
      'supprime tout ce que tu sais de moi',
      'efface notre conversation',
      'Supprime mes données stp',
      'peux-tu effacer nos échanges ?',
      "OUBLIE CE QUE JE T'AI DIT",
      'supprime ce que tu as retenu de moi',
    ];

    for (const text of asked) {
      expect(requestsErasure(text), text).toBe(true);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // LA DÉCISION CENTRALE DU MODULE
  // ══════════════════════════════════════════════════════════════════════════
  // Un faux positif DÉTRUIT des données et rien ne les rétablit. Chacune de ces phrases
  // contient un verbe d'effacement ; aucune ne demande d'effacer une mémoire.
  it("n'intercepte pas une correction conversationnelle", () => {
    // « non, ignore ça » sous une autre forme : la phrase porte sur le dernier échange,
    // pas sur ce que le bot a retenu. L'intercepter effacerait un fil parce que quelqu'un
    // s'est repris.
    expect(requestsErasure('oublie ça')).toBe(false);
    expect(requestsErasure('non, oublie')).toBe(false);
    expect(requestsErasure('oublie, je me suis trompé')).toBe(false);
  });

  it("n'intercepte pas une négation", () => {
    expect(requestsErasure("n'oublie pas de relancer Awa")).toBe(false);
    expect(requestsErasure('ne supprime pas mes données')).toBe(false);
    expect(requestsErasure('sans effacer notre conversation')).toBe(false);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // NON-RÉGRESSION — les six phrases sur lesquelles une revue adversariale a
  // REPRODUIT une perte de données réelle, sur la première version du module
  // ══════════════════════════════════════════════════════════════════════════
  // Elles contiennent toutes le verbe ET l'objet. Ce qui les distingue d'un ordre n'est pas
  // leur vocabulaire mais leur ACTE DE LANGAGE : question, reproche, pronostic, refus.
  // Aucune liste de mots ne peut les écarter ; la position du verbe le peut.
  describe('phrases qui contiennent le verbe et l objet sans rien ordonner', () => {
    it("écarte une négation SÉPARÉE du verbe — le pire cas, il demandait l'inverse", () => {
      // « pas » est à deux mots du verbe : invisible pour une garde d'adjacence. Cette
      // phrase demande de GARDER la mémoire et l'effaçait.
      expect(requestsErasure("Je ne veux surtout pas que tu oublies ce que je t'ai dit")).toBe(
        false,
      );
    });

    it('écarte une QUESTION sur l avenir', () => {
      expect(
        requestsErasure("Est-ce que tu vas oublier ce que je t'ai dit si je change d'avis ?"),
      ).toBe(false);
    });

    it('écarte un REPROCHE sur le passé', () => {
      expect(requestsErasure("Pourquoi as-tu oublié ce que je t'ai dit hier ?")).toBe(false);
    });

    it('écarte un PRONOSTIC', () => {
      expect(requestsErasure("Tu risques d'oublier ce que je t'ai dit, non ?")).toBe(false);
    });

    it('écarte un oubli NARRÉ par la personne elle-même', () => {
      expect(
        requestsErasure(
          "j'ai oublié de te dire un truc important, mais retiens bien ce que je t'ai dit avant",
        ),
      ).toBe(false);
      expect(requestsErasure("je vais oublier mes clés, tu peux noter ce que je t'ai dit ?")).toBe(
        false,
      );
    });

    it("écarte une conversation qui n'est pas la nôtre", () => {
      // « la conversation » nu a été retiré des objets reconnus : il désigne aussi bien la
      // nôtre que celle d'un tiers, et l'ambiguïté se paierait par la destruction de la
      // mauvaise.
      expect(requestsErasure("supprime la conversation d'Awa avec les RH")).toBe(false);
    });
  });

  it('reconnaît un ordre qui n ouvre pas le message, quand la demande est explicite', () => {
    // La contrepartie du critère de POSITION : sans les formules de demande, « peux-tu
    // effacer nos échanges ? » serait écarté comme une question — alors que c'en est une
    // qui ordonne.
    expect(requestsErasure('peux-tu effacer nos échanges ?')).toBe(true);
    expect(requestsErasure('merci de supprimer mes données')).toBe(true);
    expect(requestsErasure("j'aimerais que tu oublies ce que je t'ai dit")).toBe(true);
  });

  it("n'intercepte pas une suppression qui vise autre chose que la mémoire", () => {
    expect(requestsErasure('supprime le compte de Awa')).toBe(false);
    expect(requestsErasure('efface la tâche 3 de ma liste')).toBe(false);
    expect(requestsErasure('supprime tout')).toBe(false);
  });

  it("n'intercepte pas une simple mention de la conversation", () => {
    expect(requestsErasure('résume notre conversation')).toBe(false);
    expect(requestsErasure("donne-moi l'historique de mes notifications")).toBe(false);
  });

  it('ignore un texte vide, absent, ou trop long pour être une demande directe', () => {
    expect(requestsErasure('')).toBe(false);
    expect(requestsErasure(undefined)).toBe(false);
    expect(requestsErasure(null)).toBe(false);
    // Une sous-chaîne noyée dans un paragraphe ne doit pas déclencher une suppression.
    expect(requestsErasure(`${'a'.repeat(400)} oublie ce que je t'ai dit`)).toBe(false);
  });
});

describe('Réponses rendues', () => {
  it("nomme toujours ce que l'effacement NE couvre PAS", () => {
    // C'est la moitié du correctif : « c'est fait » tout court laisserait croire que plus
    // rien ne subsiste, alors que documents, notifications et annuaire sont intacts.
    expect(erasureDoneReply(3)).toContain(ERASURE_SCOPE_NOTICE);
    expect(erasureDoneReply(0)).toContain(ERASURE_SCOPE_NOTICE);
  });

  it('dit combien de messages ont réellement été supprimés', () => {
    expect(erasureDoneReply(0)).toContain("Je n'avais rien retenu");
    expect(erasureDoneReply(1)).toContain('1 message ');
    expect(erasureDoneReply(4)).toContain('4 messages');
  });

  it("n'annonce jamais une suppression quand la mémoire est indisponible", () => {
    // Toute la valeur du correctif tient dans le fait que la réponse dit ce qui s'est
    // réellement passé. Annoncer un effacement qui n'a pas eu lieu est pire que rien.
    expect(ERASURE_FAILED_REPLY).not.toContain("C'est effacé");
    expect(ERASURE_FAILED_REPLY).toContain("n'ai pas réussi");
  });
});
