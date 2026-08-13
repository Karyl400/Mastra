import { describe, expect, it } from 'vitest';
import { parseWelcomeChannelNames } from '../../../src/features/directory/domain/services/welcome-channel-names';

describe('parseWelcomeChannelNames', () => {
  it('découpe sur les virgules et retire les espaces', () => {
    expect(parseWelcomeChannelNames('kisso-hq, random ,signals')).toEqual([
      'kisso-hq',
      'random',
      'signals',
    ]);
  });

  it('retire le # de tête — un humain écrit le canal comme il le lit', () => {
    expect(parseWelcomeChannelNames('#kisso-hq,#random')).toEqual(['kisso-hq', 'random']);
  });

  it('normalise en minuscules : les noms de canaux Slack le sont toujours', () => {
    expect(parseWelcomeChannelNames('Kisso-HQ')).toEqual(['kisso-hq']);
  });

  it('déduplique en conservant le premier ordre', () => {
    expect(parseWelcomeChannelNames('random,#random, RANDOM')).toEqual(['random']);
  });

  it('rend une liste vide quand la variable est absente, vide ou sans contenu', () => {
    expect(parseWelcomeChannelNames(undefined)).toEqual([]);
    expect(parseWelcomeChannelNames(null)).toEqual([]);
    expect(parseWelcomeChannelNames('')).toEqual([]);
    expect(parseWelcomeChannelNames('  , , ')).toEqual([]);
  });
});
