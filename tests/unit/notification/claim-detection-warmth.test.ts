import { describe, it, expect } from 'vitest';
import {
  detectUnsupportedCompletionClaim,
  ACCOMPLISHMENT_CLAIM_LABELS,
} from '../../../src/features/notification/domain/services/claim-reconciliation';

/**
 * ⚠️ CE FICHIER EST LA CONTREPARTIE DU TON DE MARCEL, ET IL A ÉTÉ ÉCRIT AVANT LUI.
 *
 * Le dépôt avait REFUSÉ tout ton chaleureux, et l'argument n'était pas le goût — il est
 * consigné dans `CLAUDE.md` : « un modèle invité à varier ses formules écrirait "voilà, ton
 * document t'attend" — hors motif, donc non requalifié. Demander de la variété au modèle
 * DÉGRADE le seul détecteur de fausses annonces. »
 *
 * L'argument est juste. Il ne dit pas « pas de ton chaleureux » : il dit « pas AVANT d'avoir
 * élargi le détecteur ». C'est l'ordre qui est retenu ici.
 *
 * Chaque phrase ci-dessous est une façon NATURELLE d'annoncer un travail fait. Si le détecteur
 * les laisse passer, alors un Marcel chaleureux peut annoncer un envoi qui n'a pas eu lieu sans
 * que rien ne le contredise — la régression exacte que ce dépôt traque depuis `emailSent: false`
 * sous `status: 'success'`.
 */
describe('Le détecteur attrape les formules CHALEUREUSES d’accompli', () => {
  const CLAIMS_TO_CATCH: ReadonlyArray<[label: string, text: string]> = [
    ['voilà', 'Voilà, ton guide d’accueil t’attend dans le fil.'],
    ['voilà', 'Et voilà ! Le document est en route vers ta boîte.'],
    ['ça y est', 'Ça y est, Pamela a reçu ton message.'],
    ['ça y est', 'Ça y est : tout est en place pour lundi.'],
    ['tu l’as', 'Tu l’as reçu, regarde dans tes messages privés.'],
    ['tu l’as', 'Tu devrais l’avoir sous les yeux maintenant.'],
    ['t’attend', 'Ton contrat t’attend juste au-dessus.'],
    ['je te l’ai', 'Je te l’ai glissé en pièce jointe.'],
    ['je te l’ai', 'Je te l’ai mis dans le fil, dis-moi si tu le vois.'],
    ['c’est parti', 'C’est parti pour Awa, elle recevra ça ce matin.'],
    ['tout est bon', 'Tout est bon de mon côté, le dossier est complet.'],
    ['tout est bon', 'Tout est réglé, tu n’as plus rien à faire.'],
    ['c’est en route', 'C’est en route, elle devrait l’avoir d’ici peu.'],
    ['bonne nouvelle', 'Bonne nouvelle : le document est généré.'],
    ['n’a plus qu’à', 'Elle n’a plus qu’à ouvrir sa boîte mail.'],
  ];

  for (const [family, text] of CLAIMS_TO_CATCH) {
    it(`requalifie « ${text} » (famille : ${family})`, () => {
      expect(detectUnsupportedCompletionClaim(text), text).not.toBeNull();
    });
  }
});

/**
 * ⚠️ L'ÉLARGISSEMENT DOIT S'ARRÊTER À LA CONTRADICTION, JAMAIS À L'INVRAISEMBLANCE.
 *
 * Le contrat d'origine est explicite : « On cherche une CONTRADICTION, jamais une
 * invraisemblance : "je peux t'envoyer…" n'en est pas une. » Un détecteur trop large accole
 * un démenti à des réponses JUSTES — et le démenti, lui, est lu par un humain. Le coût d'un
 * faux positif est donc immédiat et visible, là où le vrai positif corrige un mensonge.
 */
describe('Le détecteur ne mord PAS sur ce qui n’affirme aucun accompli', () => {
  const MUST_PASS: readonly string[] = [
    'Je peux te préparer ce guide en PDF si tu veux.',
    'Veux-tu que je l’envoie à Pamela ?',
    'Il me faut son adresse avant de pouvoir faire quoi que ce soit.',
    'Voilà ce dont j’ai besoin : son prénom et son nom.',
    'Voilà pourquoi je te le demande : sans l’adresse, je ne peux rien envoyer.',
    'Dis-moi ce que tu veux que j’y mette.',
    'Est-ce que ça y est, de ton côté ?',
    'Tu l’as déjà, ce document ? Je ne veux pas t’en refaire un.',
    'Je ne l’ai pas envoyé : il me manque son adresse.',
    'Je n’ai pas pu le générer, le service est indisponible.',
    'Bonne nouvelle ou pas, je ne peux pas décider à ta place.',
    'Tout est bon pour toi ?',
  ];

  for (const text of MUST_PASS) {
    it(`laisse passer « ${text} »`, () => {
      expect(detectUnsupportedCompletionClaim(text), text).toBeNull();
    });
  }
});

describe('La liste des familles est EXPOSÉE, donc vérifiable', () => {
  it('nomme chaque famille une seule fois', () => {
    // ⚠️ Ce n'est pas de la cosmétique. Les six motifs d'origine étaient une liste fermée dont
    // rien ne disait le contenu au-dehors : le seul moyen de savoir si une formule était
    // couverte était de lire la regex. Exposer les libellés permet à un test de ton — et à un
    // humain — de raisonner sur la COUVERTURE sans relire les motifs.
    const unique = new Set(ACCOMPLISHMENT_CLAIM_LABELS);
    expect(unique.size).toBe(ACCOMPLISHMENT_CLAIM_LABELS.length);
  });

  it('a bien GRANDI par rapport aux six motifs d’origine', () => {
    expect(ACCOMPLISHMENT_CLAIM_LABELS.length).toBeGreaterThan(6);
  });
});
