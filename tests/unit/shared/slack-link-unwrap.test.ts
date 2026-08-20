import { describe, it, expect } from 'vitest';

import { unwrapSlackLinks } from '../../../src/shared/slack-links';
import { captureProfileAnswer } from '../../../src/features/onboarding/domain/services/profile-chat';

/**
 * LA PANNE DE COMPLÉTION DE PROFIL — trouvée dans l'historique de PRODUCTION le 2026-08-20.
 *
 * Deux tours consécutifs, relevés tels quels dans `conversation_turns` :
 *
 *   user       <mailto:nazer@kissohq.com|nazer@kissohq.com>
 *   assistant  Il me faut une adresse complète, du genre `prenom.nom@kisso…`
 *   user       <mailto:nazer.herm@kissohq.com|nazer.herm@kissohq.com>
 *   assistant  Il me faut une adresse complète, du genre `prenom.nom@kisso…`
 *
 * Slack transforme AUTOMATIQUEMENT toute adresse email tapée dans un message en
 * `<mailto:adresse|libellé>`. `looksLikeEmail` exige exactement un `@` : la forme encadrée en
 * porte deux, donc `captureProfileAnswer` rendait `null` et l'étape se répétait à l'infini.
 *
 * Conséquence : PERSONNE ne pouvait terminer son dossier. Ce n'est pas un cas limite — c'est
 * le chemin nominal, puisqu'on ne peut pas taper une adresse dans Slack SANS qu'elle soit
 * encadrée. La personne réessayait avec une autre adresse, recevait le même refus, et
 * concluait que le bot était cassé.
 *
 * ⚠️ Le même encadrement s'applique aux URL (`<https://…|…>`) et aux canaux (`<#C…|nom>`).
 * On déballe la forme générale, pas le seul `mailto:` — sinon le prochain champ qui accepte
 * un lien rejouera ce défaut.
 */

describe('unwrapSlackLinks', () => {
  it('déballe une adresse email encadrée par Slack', () => {
    expect(unwrapSlackLinks('<mailto:nazer@kissohq.com|nazer@kissohq.com>')).toBe(
      'nazer@kissohq.com',
    );
  });

  it('déballe une adresse SANS libellé', () => {
    expect(unwrapSlackLinks('<mailto:a.b@c.com>')).toBe('a.b@c.com');
  });

  it('préfère le LIBELLÉ pour une URL, et la cible pour un mailto', () => {
    // Le libellé d'une URL est ce que la personne a écrit ; la cible peut être trompeuse —
    // c'est exactement le cas que `stripDisallowedLinks` traite en sortie. Pour un mailto,
    // c'est l'inverse : la cible est l'adresse réelle, le libellé un affichage.
    expect(unwrapSlackLinks('<https://exemple.fr|notre site>')).toBe('notre site');
    expect(unwrapSlackLinks('<mailto:vrai@x.fr|Écris-moi>')).toBe('vrai@x.fr');
  });

  it('laisse intact un texte sans encadrement', () => {
    expect(unwrapSlackLinks('nazer@kissohq.com')).toBe('nazer@kissohq.com');
    expect(unwrapSlackLinks('Backend Developer')).toBe('Backend Developer');
  });

  it('déballe au milieu d’une phrase, sans toucher au reste', () => {
    expect(unwrapSlackLinks('mon mail est <mailto:a@b.fr|a@b.fr> merci')).toBe(
      'mon mail est a@b.fr merci',
    );
  });

  it('ne touche pas aux mentions ni aux jetons de canal nus', () => {
    // `<@U123>` et `<#C123>` sont traités ailleurs et ont leur propre sens.
    expect(unwrapSlackLinks('<@U0BM123>')).toBe('<@U0BM123>');
  });

  it('NE LÈVE JAMAIS', () => {
    expect(() => unwrapSlackLinks('<mailto:')).not.toThrow();
    expect(() => unwrapSlackLinks('<<<>>>')).not.toThrow();
    expect(unwrapSlackLinks(undefined)).toBe('');
  });
});

describe('captureProfileAnswer — la forme réellement reçue de Slack', () => {
  it('ACCEPTE une adresse encadrée — le cas nominal, cassé jusqu’au 2026-08-20', () => {
    expect(captureProfileAnswer('email', '<mailto:nazer@kissohq.com|nazer@kissohq.com>')).toBe(
      'nazer@kissohq.com',
    );
    expect(
      captureProfileAnswer('email', '<mailto:nazer.herm@kissohq.com|nazer.herm@kissohq.com>'),
    ).toBe('nazer.herm@kissohq.com');
  });

  it('accepte toujours une adresse nue', () => {
    expect(captureProfileAnswer('email', 'marcel.testeur@example.com')).toBe(
      'marcel.testeur@example.com',
    );
  });

  it('refuse toujours ce qui n’est pas une adresse', () => {
    expect(captureProfileAnswer('email', 'je sais pas')).toBeNull();
    expect(captureProfileAnswer('email', 'Marcel')).toBeNull();
    expect(captureProfileAnswer('email', '<mailto:pas-une-adresse>')).toBeNull();
  });
});

describe('coût — la garde est EMPIRIQUE, pas statique', () => {
  it('reste linéaire sur des charges adverses de 8 000 caractères', () => {
    // `security/detect-unsafe-regex` signale ce motif : son heuristique ne sait pas voir que
    // les deux classes sont exclusives (`[^|>]`) et bornées à `{0,2000}`. Le dépôt a déjà
    // tranché ce cas sur `llm-guardrail.ts` — on désactive la règle et on MESURE, parce
    // qu'une mesure dit ce qu'une heuristique suppose.
    const charges = [
      `<mailto:${'a'.repeat(8000)}`,
      `${'<'.repeat(4000)}mailto:x`,
      `<mailto:${'a|'.repeat(4000)}>`,
      `${'<mailto:a@b.fr|a@b.fr>'.repeat(360)}`,
    ];

    for (const charge of charges) {
      const started = Date.now();
      unwrapSlackLinks(charge);
      expect(Date.now() - started, `${charge.length} caractères`).toBeLessThan(50);
    }
  });
});
