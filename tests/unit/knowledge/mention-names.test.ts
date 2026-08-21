import { describe, it, expect } from 'vitest';

import {
  resolveMentions,
  mentionedUserIds,
} from '../../../src/features/knowledge/domain/services/mention-names';

/**
 * Une mention Slack est un IDENTIFIANT. Le modèle les recopiait tels quels dans ses résumés —
 * « <@U0BJ8F1AMNF> a validé le déploiement », que personne ne peut lire.
 *
 * ⚠️ La correction est en CODE et non en consigne : le modèle n'a aucun moyen de résoudre un
 * identifiant, l'annuaire n'étant pas dans sa fenêtre. Le lui demander, c'est lui demander
 * d'inventer.
 */
const DIRECTORY: Record<string, string> = {
  U0BJ8F1AMNF: 'Karyl SOUMAILA',
  U0AWA: 'Awa TRAORE',
};
const lookup = (id: string) => DIRECTORY[id];

describe('resolveMentions', () => {
  it('remplace une mention par le nom', () => {
    expect(resolveMentions('<@U0BJ8F1AMNF> a validé le déploiement', lookup)).toBe(
      '@Karyl SOUMAILA a validé le déploiement',
    );
  });

  it('gère la forme ancienne `<@U123|libellé>`', () => {
    expect(resolveMentions('<@U0AWA|awa> arrive lundi', lookup)).toBe('@Awa TRAORE arrive lundi');
  });

  it('remplace plusieurs mentions, y compris la même deux fois', () => {
    expect(resolveMentions('<@U0AWA> et <@U0BJ8F1AMNF> et <@U0AWA>', lookup)).toBe(
      '@Awa TRAORE et @Karyl SOUMAILA et @Awa TRAORE',
    );
  });

  it("LAISSE INTACT un identifiant inconnu — on n'invente pas un nom", () => {
    // Compte supprimé, bot, personne d'un autre workspace. Mettre « quelqu'un » effacerait la
    // distinction entre deux inconnus différents du même extrait ; inventer serait pire.
    expect(resolveMentions('<@U0INCONNU> a répondu', lookup)).toBe('<@U0INCONNU> a répondu');
  });

  it('préfère le nom de canal à son identifiant', () => {
    expect(resolveMentions('vu dans <#CMLKC4S5T|kisso-hq>', lookup)).toBe('vu dans #kisso-hq');
  });

  it('rend le texte inchangé quand il ne contient aucune mention', () => {
    // Le cas le plus fréquent : il ne doit rien coûter et rien abîmer.
    const plain = 'On décale la revue de sprint à jeudi.';
    expect(resolveMentions(plain, lookup)).toBe(plain);
  });

  it('ne confond pas une adresse email avec une mention', () => {
    const text = 'écris à awa@kissohq.com';
    expect(resolveMentions(text, lookup)).toBe(text);
  });
});

describe('mentionedUserIds', () => {
  it('rend les identifiants sans doublon, pour ne résoudre qu’une fois', () => {
    expect(mentionedUserIds(['<@U0AWA> et <@U0BJ8F1AMNF>', 'encore <@U0AWA>']).sort()).toEqual([
      'U0AWA',
      'U0BJ8F1AMNF',
    ]);
  });

  it('rend une liste vide sans mention — aucune lecture d’annuaire à faire', () => {
    expect(mentionedUserIds(['rien ici', ''])).toEqual([]);
  });
});
