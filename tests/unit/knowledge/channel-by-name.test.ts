import { describe, it, expect, beforeEach } from 'vitest';

import { makeGetChannelHistory } from '../../../src/features/knowledge/application/tools/get-channel-history';
import { resolveChannelName } from '../../../src/features/knowledge/domain/services/channel-name-matching';
import { InMemoryChannelHistoryAdapter } from '../../../src/features/knowledge/infrastructure/providers/in-memory-channel-history.adapter';
import { InMemoryDirectoryRepository } from '../../../src/features/directory/infrastructure/repositories/in-memory-directory.repository';
import type { ChannelMessage } from '../../../src/features/knowledge/domain/ports/channel-history.port';
import { buildSlackRequestContext } from '../../../src/shared/slack-request-context';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « RÉSUME LA CONVERSATION DANS LE CANAL ENGINEER-KARYL » ÉTAIT INSATISFAISABLE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Mesuré en production, 2026-08-25 : *« Je ne trouve aucune information sur le canal
 * « engineer-karyl ». **Sans l'identifiant du canal, je ne peux pas récupérer l'historique.** »*
 *
 * Le modèle disait la stricte vérité — et c'est ce qui rend le défaut grave. `getChannelHistory`
 * n'acceptait qu'un `C…`/`G…`, son `.describe()` disait *« Identifiant du canal, pas son nom »*,
 * et l'instruction de l'agent le répétait mot pour mot. **Personne ne connaît l'identifiant d'un
 * canal Slack** : il n'apparaît nulle part dans le client, et un humain n'a aucune raison de
 * l'avoir sous la main.
 *
 * ⚠️ **QUATRIÈME OCCURRENCE DE LA DEMANDE STRUCTURELLEMENT INSATISFAISABLE**, après la recherche
 * par email inatteignable (2026-08-10), la boucle « donne-moi son identifiant » du 2026-08-11, et
 * l'email d'entretien routé vers un agent qui exige une ligne d'annuaire qu'un candidat n'a pas
 * (2026-08-14). Le motif est toujours le même : **le harness réclame une valeur qu'aucun chemin
 * ne peut produire**, et le refus paraît raisonnable parce qu'il est exact.
 *
 * ⚠️ Ce n'est PAS visible quand on clique `#kisso-hq` dans le champ de saisie : le client Slack
 * pose alors le jeton `<#C…|nom>`, qui porte l'identifiant. Le défaut ne se manifeste que quand
 * la personne ÉCRIT le nom — c'est-à-dire dans la formulation la plus naturelle.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LA RÉSOLUTION NE PEUT PAS DEVENIR UN ORACLE, ET C'EST STRUCTUREL
 * ════════════════════════════════════════════════════════════════════════════
 *
 * On ne résout PAS contre l'annuaire des canaux du workspace : ce serait un moyen de découvrir
 * l'existence de canaux privés une supposition à la fois. On résout contre **les canaux dont le
 * DEMANDEUR est membre** (`listMemberChannels`, soit `users.conversations`).
 *
 * Même propriété que la lecture en direct de `searchKnowledge` : *« la frontière tient par la
 * CONSTRUCTION de la liste, pas par un filtre — donc il n'y a rien à filtrer ensuite, donc rien à
 * oublier de filtrer. »* Un nom que le demandeur ne peut pas voir ne se distingue pas d'un nom
 * qui n'existe pas.
 */

const HR = 'U_HR';
const OUTSIDER = 'U_OUT';

const NOW = new Date();

function message(text: string, minutesAgo: number): ChannelMessage {
  return {
    authorId: HR,
    authorLabel: 'Karyl',
    text,
    at: new Date(NOW.getTime() - minutesAgo * 60_000),
    isBot: false,
  };
}

describe('rapprochement d’un nom de canal — le CODE, pas le modèle', () => {
  const refs = [
    { id: 'CMLKC4S5T', name: 'kisso-hq' },
    { id: 'C0BJGBVB5HP', name: 'engineer-karyl' },
    { id: 'C0BP3RCLLA1', name: 'engineering-chat' },
  ];

  it('retrouve un canal quelle que soit la façon dont on l’écrit', () => {
    for (const written of [
      'engineer-karyl',
      '#engineer-karyl',
      'Engineer-Karyl',
      ' engineer karyl ',
    ]) {
      expect(resolveChannelName(refs, written), written).toEqual({ id: 'C0BJGBVB5HP' });
    }
  });

  it('ne rend RIEN sur une ambiguïté — jamais un identifiant choisi au hasard', () => {
    // ⚠️ Même règle que `findPersonByName` : rendre deux identifiants reviendrait à laisser le
    // modèle en choisir un, c'est-à-dire le geste même qui a produit le bug de destinataire du
    // 2026-08-14. Sans identifiant, l'appel suivant est impossible et le modèle DOIT demander.
    expect(resolveChannelName(refs, 'engineer')).toEqual({
      ambiguous: ['engineer-karyl', 'engineering-chat'],
    });
  });

  it('un nom inconnu ne résout rien', () => {
    expect(resolveChannelName(refs, 'direction')).toBeNull();
    expect(resolveChannelName(refs, '')).toBeNull();
  });

  it('un nom EXACT l’emporte sur un préfixe — sinon « engineer-karyl » resterait ambigu', () => {
    const withPrefixTwin = [
      { id: 'C_A', name: 'random' },
      { id: 'C_B', name: 'random-dev' },
    ];
    expect(resolveChannelName(withPrefixTwin, 'random')).toEqual({ id: 'C_A' });
  });
});

describe('le tool accepte enfin un NOM', () => {
  let directory: InMemoryDirectoryRepository;
  let channels: InMemoryChannelHistoryAdapter;

  beforeEach(() => {
    directory = new InMemoryDirectoryRepository();
    channels = new InMemoryChannelHistoryAdapter();
    channels.setMembers('C0BJGBVB5HP', [HR]);
    channels.nameChannel('C0BJGBVB5HP', 'engineer-karyl');
    channels.seed('C0BJGBVB5HP', [message('On a décidé de partir sur postgres.', 30)]);
  });

  const run = (input: Record<string, unknown>, user = HR) =>
    makeGetChannelHistory({ directory, channels }).execute!(
      input as never,
      {
        requestContext: buildSlackRequestContext({ channel: 'D0X', slackUserId: user }),
      } as never,
    ) as Promise<{ found: boolean; reason?: string; conversation?: string }>;

  it('« engineer-karyl » suffit — plus besoin d’un identifiant', async () => {
    const result = await run({ channelName: 'engineer-karyl' });

    expect(result.found).toBe(true);
    expect(result.conversation).toContain('postgres');
  });

  it('l’identifiant continue de fonctionner — rien de ce qui marchait ne bouge', async () => {
    const result = await run({ channelId: 'C0BJGBVB5HP' });
    expect(result.found).toBe(true);
  });

  it('un nom que le DEMANDEUR ne peut pas voir est indiscernable d’un nom inexistant', async () => {
    // Les deux moitiés de la propriété anti-oracle, dans une seule assertion : le verdict rendu
    // à quelqu'un d'extérieur est le MÊME pour un canal réel et pour un canal imaginaire.
    const real = await run({ channelName: 'engineer-karyl' }, OUTSIDER);
    const imaginary = await run({ channelName: 'canal-qui-nexiste-pas' }, OUTSIDER);

    expect(real.reason).toBe('channel_not_found');
    expect(imaginary.reason).toBe(real.reason);
  });

  it('une ambiguïté est DITE, et ne lit aucun canal', async () => {
    channels.setMembers('C0BP3RCLLA1', [HR]);
    channels.nameChannel('C0BP3RCLLA1', 'engineering-chat');

    const result = await run({ channelName: 'engineer' });

    expect(result.found).toBe(false);
    expect(result.reason).toBe('ambiguous_channel');
  });

  it('ni nom ni identifiant : le schéma REFUSE, il ne devine pas', async () => {
    // ⚠️ MESURÉ, pas supposé : Mastra valide bien l'`inputSchema`, mais il ne LÈVE pas — il rend
    // `{ error: true, message }` au modèle. C'est le bon comportement ici (le modèle peut
    // corriger son appel), à condition de ne pas écrire un test qui attend une exception : il
    // serait rouge pour une raison qui n'a rien à voir avec la propriété vérifiée.
    const result = (await run({})) as unknown as { error?: boolean; found?: boolean };

    expect(result.error).toBe(true);
    expect(result.found).toBeUndefined();
  });
});
