import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { slackErrorCode, slackErrorMentions } from '../../../src/shared/slack/slack-error';

/**
 * Extraction UNIQUE du code d'erreur Slack.
 *
 * Cinq stratégies incompatibles coexistaient dans `src/` — mesurées avant unification :
 *
 * | site                                | `data.error` | `message`            | suit `cause` |
 * | ----------------------------------- | ------------ | -------------------- | ------------ |
 * | `slack.adapter.ts` (isSlackError)   | égalité      | `includes`, en repli | non          |
 * | `slack-channel-history.adapter.ts`  | exclusif     | jamais               | non          |
 * | `generate-document.ts`              | égalité      | `includes`           | OUI (prof. 4)|
 * | `slack-welcome-channel.adapter.ts`  | égalité      | balayage de table    | non          |
 * | `slack-workspace.service.ts`        | jamais       | `includes` seulement | non          |
 *
 * La divergence est observable : `SlackAdapter.uploadFile` enveloppe l'erreur Slack dans
 * `cause` pour retraduire `missing_scope` en prose adressée à un humain. Les quatre stratégies
 * qui ne traversent pas `cause` ratent donc le code sur ce chemin précis — le seul du dépôt où
 * une erreur Slack est délibérément ré-enveloppée.
 */
describe('slackErrorCode', () => {
  it('lit `data.error`, la forme authentique de @slack/web-api', () => {
    expect(slackErrorCode({ data: { error: 'missing_scope' } })).toBe('missing_scope');
  });

  it('lit le message de l’API Slack quand `data` manque', () => {
    // Forme exacte produite par le SDK : `An API error occurred: <code>`.
    expect(slackErrorCode(new Error('An API error occurred: not_in_channel'))).toBe(
      'not_in_channel',
    );
  });

  it('accepte un message réduit au seul code — la forme des doublures de test', () => {
    expect(slackErrorCode(new Error('channel_not_found'))).toBe('channel_not_found');
  });

  it('traverse `cause` à la profondeur 1', () => {
    const wrapped = new Error('Slack refuse l’upload : le scope `files:write` manque au bot.', {
      cause: { data: { error: 'missing_scope' } },
    });
    expect(slackErrorCode(wrapped)).toBe('missing_scope');
  });

  it('traverse `cause` à la profondeur 3', () => {
    const deep = new Error('a', {
      cause: new Error('b', {
        cause: new Error('c', { cause: { data: { error: 'ratelimited' } } }),
      }),
    });
    expect(slackErrorCode(deep)).toBe('ratelimited');
  });

  it('accepte une valeur qui n’est pas une `Error` — @slack/web-api rejette parfois un objet nu', () => {
    expect(slackErrorCode({ data: { error: 'expired_trigger_id' } })).toBe('expired_trigger_id');
    expect(slackErrorCode('missing_scope')).toBe('missing_scope');
  });

  it('rend `undefined` sur `null` et `undefined` plutôt que de lever', () => {
    expect(slackErrorCode(null)).toBeUndefined();
    expect(slackErrorCode(undefined)).toBeUndefined();
  });

  it('rend `undefined` sur une erreur qui ne porte aucun code', () => {
    expect(slackErrorCode(new Error('socket hang up'))).toBeUndefined();
    expect(slackErrorCode({ data: {} })).toBeUndefined();
    expect(slackErrorCode({ data: { error: 42 } })).toBeUndefined();
  });

  it('préfère `data.error` au message, même si le message est moins profond', () => {
    // `data.error` est le champ que Slack renseigne ; un message est de la prose, y compris
    // celle qu'un enrobage du dépôt a lui-même écrite.
    const wrapped = new Error('An API error occurred: ratelimited', {
      cause: { data: { error: 'missing_scope' } },
    });
    expect(slackErrorCode(wrapped)).toBe('missing_scope');
  });

  it('ne boucle pas sur une chaîne `cause` cyclique', () => {
    // Une erreur d'un mot minuscule EST lue comme un code (`ratelimited`, `accountinactive`
    // en sont) : ces messages-ci doivent donc en contenir plusieurs pour que l'assertion
    // porte sur la terminaison et non sur l'extraction.
    const a = new Error('socket hang up');
    const b = new Error('connection reset', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(slackErrorCode(a)).toBeUndefined();
  });
});

describe('slackErrorMentions', () => {
  it('reconnaît le code exact', () => {
    expect(slackErrorMentions({ data: { error: 'missing_scope' } }, 'missing_scope')).toBe(true);
  });

  it('reconnaît un code cité dans un message quelconque — ce que faisaient trois des cinq sites', () => {
    expect(
      slackErrorMentions(
        new Error('Slack said already_in_channel, ignoring'),
        'already_in_channel',
      ),
    ).toBe(true);
  });

  it('reconnaît un jeton qui n’est pas un code Slack — l’heuristique `files:write`', () => {
    // `files:write` est un SCOPE, jamais un code d'erreur : il ne peut venir que du texte
    // écrit par `SlackAdapter.uploadFile`. `slackErrorCode` ne le rendra donc jamais.
    const wrapped = new Error('le scope `files:write` manque au bot', {
      cause: { data: { error: 'missing_scope' } },
    });
    expect(slackErrorCode(wrapped)).toBe('missing_scope');
    expect(slackErrorMentions(wrapped, 'files:write')).toBe(true);
  });

  it('reste faux quand le code n’apparaît nulle part', () => {
    expect(slackErrorMentions(new Error('socket hang up'), 'missing_scope')).toBe(false);
    expect(slackErrorMentions(null, 'missing_scope')).toBe(false);
  });
});

/**
 * Ancrage de la convergence : le code d'erreur Slack ne se relit plus nulle part à la main.
 *
 * Ce qui reste DIVERGENT à dessein, et ne doit pas être unifié : les TABLES de correspondance.
 * `slack-welcome-channel.adapter.ts` traduit un code en statut destiné à un message HUMAIN ;
 * `slack-channel-history.adapter.ts` le traduit en verdict de TOOL, et range délibérément
 * `not_in_channel`, `missing_scope` et `channel_not_found` sous le même `bot_not_in_channel` —
 * parce que la seule chose que la personne puisse faire dans les trois cas est d'inviter le bot.
 * Les fusionner ferait dire à l'une ce que l'autre a besoin de taire. Seule l'EXTRACTION est
 * partagée.
 */
describe('la convergence des cinq stratégies', () => {
  const DATA_ERROR_RE = /\.data\?\.error|\bdata\.error\b|\{\s*error\?:\s*unknown\s*\}/;

  function sourceFiles(dir: string, acc: string[] = []): string[] {
    if (!fs.existsSync(dir)) return acc;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(full, acc);
      else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) acc.push(full);
    }
    return acc;
  }

  it('plus aucun fichier de `src/` ne relit `data.error` en direct', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const shared = path.join(root, 'src/shared/slack/slack-error.ts');

    const offenders = sourceFiles(path.join(root, 'src'))
      .filter((file) => file !== shared)
      .filter((file) => DATA_ERROR_RE.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file));

    expect(offenders, 'Utiliser `slackErrorCode` de `src/shared/slack/slack-error.ts`').toEqual([]);
  });

  it('le motif reconnaît bien ce qu’il interdit', () => {
    expect(
      DATA_ERROR_RE.test('const c = (e as { data?: { error?: unknown } })?.data?.error;'),
    ).toBe(true);
    expect(DATA_ERROR_RE.test("if (typeof data.error === 'string') return data.error;")).toBe(true);
    expect(DATA_ERROR_RE.test('const code = (data as { error?: unknown }).error;')).toBe(true);
  });
});
