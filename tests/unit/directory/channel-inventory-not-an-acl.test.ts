import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * L'INVENTAIRE DES CANAUX N'EST PAS UNE ACL — INTERDIT EXÉCUTABLE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le mode d'échec visé est nommé, et il est probable : quelqu'un finira par lire
 * `slack_channel_members` comme une liste d'autorisation. « Les membres de #engineer-karyl »
 * RESSEMBLE à « qui a le droit de voir #engineer-karyl » — c'est précisément ce qui rend
 * l'erreur facile. Or `#engineer-karyl` est PRIVÉ, et servir son contenu à un non-membre sur la
 * foi de ces lignes est exactement le « deputy confus » de `PLAN-ARCHITECTURE.md` §4.1, que la
 * feature `knowledge` ferme en interrogeant Slack EN DIRECT à chaque décision de divulgation.
 *
 * L'aggravant est vérifié : **il n'existe aucun chemin d'invalidation**. Les abonnements de
 * l'app Slack sont `app_mention`, `message.im`, `message.channels`, `message.groups` — ni
 * `member_joined_channel`, ni `member_left_channel`. Aucun événement ne viendra jamais démentir
 * une ligne de cet inventaire : elle n'est pas « périmée dans trois jours », elle est fausse et
 * silencieuse dès la première personne qui quitte un canal entre deux synchronisations.
 *
 * D'où ce fichier. Un commentaire se contourne sans le lire ; ce test échoue.
 *
 * Trois garanties, dans l'ordre de leur importance :
 *   1. aucun consommateur de décision (la feature `knowledge`, `access-policy`, `access-guard`)
 *      n'importe l'inventaire ;
 *   2. le port n'expose AUCUNE méthode dont le NOM pose une question d'autorisation ;
 *   3. le balayage lui-même est vivant — un renommage de dossier ne doit pas rendre ce
 *      garde-fou vert à vide, défaut qu'a réellement connu la version d'origine de
 *      `architecture.test.ts`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

/** Le module dont l'importation est interdite hors de la feature `directory`. */
const PORT = 'src/features/directory/domain/ports/channel.repository.ts';

/**
 * Les modules de l'inventaire, par leur BASENAME sans extension. On compare sur le basename et
 * non sur le chemin complet : un import est relatif (`../../directory/domain/ports/channel.repository`)
 * et sa forme dépend de l'emplacement de l'importateur.
 */
const FORBIDDEN_MODULES: ReadonlyArray<{ basename: string; file: string }> = [
  { basename: 'channel.repository', file: PORT },
  {
    basename: 'slack-channel',
    file: 'src/features/directory/domain/entities/slack-channel.ts',
  },
  {
    basename: 'drizzle-channel.repository',
    file: 'src/features/directory/infrastructure/repositories/drizzle-channel.repository.ts',
  },
  {
    basename: 'in-memory-channel.repository',
    file: 'src/features/directory/infrastructure/repositories/in-memory-channel.repository.ts',
  },
];

/**
 * Les fichiers qui prennent — ou préparent — une décision d'accès.
 *
 * `knowledge/**` en entier : c'est la feature qui décide de ce qui est divulgué, et le raccourci
 * « je lis la table des membres au lieu d'interroger Slack » y est à la fois tentant et fatal.
 * Les deux autres sont les fichiers nommément chargés de l'autorisation.
 */
const KNOWLEDGE_DIR = 'src/features/knowledge';
const DECISION_FILES: readonly string[] = [
  'src/features/directory/domain/services/access-policy.ts',
  'src/features/directory/application/services/access-guard.ts',
];

/** Capture les 4 formes de dépendance d'un module TS — même expression qu'`architecture.test.ts`. */
const IMPORT_RE =
  /(?:^|\n)\s*import\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*export\s[^;]*?from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(full, acc);
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) acc.push(full);
  }
  return acc;
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (spec) specs.push(spec);
  }
  return specs;
}

/** Le basename d'un spécificateur, extension `.ts`/`.js` retirée. */
function moduleBasename(spec: string): string {
  return path.basename(spec).replace(/\.(ts|js|mts|mjs)$/, '');
}

/** Les modules d'inventaire importés par cette source, s'il y en a. */
function forbiddenImportsOf(source: string): string[] {
  const hits: string[] = [];
  for (const spec of importSpecifiers(source)) {
    // On ne retient un `slack-channel` que s'il désigne bien le module d'entité : les
    // adaptateurs voisins `slack-channel-access.adapter` et `slack-channel-history.adapter` ont
    // un basename différent, donc la comparaison EXACTE suffit et ne les capture pas.
    const base = moduleBasename(spec);
    if (FORBIDDEN_MODULES.some((module) => module.basename === base)) hits.push(spec);
  }
  return hits;
}

/** Les fichiers surveillés : toute la feature `knowledge`, plus les deux décideurs nommés. */
function guardedFiles(): string[] {
  const knowledge = collectTsFiles(path.resolve(REPO_ROOT, KNOWLEDGE_DIR));
  const decision = DECISION_FILES.map((rel) => path.resolve(REPO_ROOT, rel));
  return [...knowledge, ...decision];
}

describe("L'inventaire des canaux n'est jamais une source d'autorisation", () => {
  it("n'est importé ni par `knowledge/**`, ni par `access-policy`, ni par `access-guard`", () => {
    const violations: string[] = [];

    for (const file of guardedFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      for (const spec of forbiddenImportsOf(source)) {
        violations.push(`${path.relative(REPO_ROOT, file)} importe "${spec}"`);
      }
    }

    expect(
      violations,
      [
        "L'inventaire des canaux (`slack_channels` / `slack_channel_members`) est de",
        "l'OBSERVABILITÉ, jamais une source d'autorisation : aucun événement Slack ne l'invalide",
        '(`member_joined_channel` et `member_left_channel` ne sont pas abonnés), donc il est faux',
        "et silencieux dès qu'une personne quitte un canal. Une décision d'accès doit interroger",
        'Slack EN DIRECT, comme le fait déjà `knowledge`. Violations :',
        `  - ${violations.join('\n  - ')}`,
      ].join('\n'),
    ).toEqual([]);
  });

  it("n'expose aucune méthode dont le nom pose une question d'autorisation", () => {
    // Le nommage EST le garde-fou : un `isMemberOf(channelId, userId)` obtiendrait une réponse
    // traitée comme un droit par le premier appelant venu, quelle que soit la prose au-dessus.
    // Les méthodes doivent dire ce qu'elles font — LISTER ce qui a été OBSERVÉ.
    const source = fs.readFileSync(path.resolve(REPO_ROOT, PORT), 'utf8');

    const methods = [...source.matchAll(/^ {2}([a-zA-Z]\w*)\(/gm)].map((m) => m[1]);
    expect(
      methods.length,
      'aucune méthode trouvée — le balayage du port est cassé',
    ).toBeGreaterThan(3);

    const authorizationShaped = methods.filter((name) =>
      /^(can|is|may|should|allow|permit|authori[sz]e|check|verify|assert|ensure|grant)[A-Z]?/.test(
        name,
      ),
    );

    expect(
      authorizationShaped,
      `Méthodes au nom de prédicat d'autorisation dans ${PORT} : ${authorizationShaped.join(', ')}`,
    ).toEqual([]);
  });

  it('balaye réellement les fichiers annoncés (anti faux-négatif)', () => {
    // Sans cette assertion, un renommage de `knowledge/` ferait passer le garde-fou au vert à
    // vide — exactement le défaut de la première version d'`architecture.test.ts`, dont le
    // second test était un placeholder assumé.
    const files = guardedFiles();
    expect(files.length, 'le balayage ne trouve plus rien').toBeGreaterThanOrEqual(10);

    for (const rel of DECISION_FILES) {
      expect(fs.existsSync(path.resolve(REPO_ROOT, rel)), `${rel} est introuvable`).toBe(true);
    }

    for (const module of FORBIDDEN_MODULES) {
      expect(
        fs.existsSync(path.resolve(REPO_ROOT, module.file)),
        `${module.file} est introuvable — la liste des modules interdits est périmée`,
      ).toBe(true);
    }
  });

  it('détecte effectivement un import interdit (contrôle positif)', () => {
    // Un garde-fou qui ne sait pas reconnaître la faute qu'il surveille est un garde-fou vert
    // par construction. On lui montre donc la faute.
    const coupable = `
      import type { ChannelInventoryRepository } from '../../../directory/domain/ports/channel.repository';
      export const x = 1;
    `;
    expect(forbiddenImportsOf(coupable)).toHaveLength(1);

    // …et il ne doit PAS capturer les voisins légitimes, dont le basename diffère.
    const innocent = `
      import { SlackChannelAccess } from '../../directory/infrastructure/providers/slack-channel-access.adapter';
      import { SlackChannelHistory } from './slack-channel-history.adapter';
    `;
    expect(forbiddenImportsOf(innocent)).toEqual([]);
  });
});
