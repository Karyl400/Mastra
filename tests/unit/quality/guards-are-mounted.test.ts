import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * UN GARDE ÉCRIT N'EST PAS UN GARDE MONTÉ
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Ce dépôt a payé cette distinction trois fois, sous trois formes :
 *
 *  1. **La route qui n'existait pas.** `POST /api/slack-events` répondait 404 : un fichier posé
 *     dans `src/api/` n'est JAMAIS monté automatiquement. C'était la cause du bot muet.
 *  2. **Le middleware inopérant.** `createCallerErrorMiddleware` a été mort depuis son écriture
 *     sur son chemin principal — dans Hono, un middleware qui a appelé `next()` doit ASSIGNER
 *     `c.res`, pas retourner. Ses tests unitaires assertaient le RETOUR : verts sur du code mort.
 *  3. **Le détecteur désarmé.** `READ_ONLY_TOOL_NAMES` gardait un outil retiré et ignorait deux
 *     outils ajoutés le même jour.
 *
 * À chaque fois, le test unitaire du composant était vert. Ce qui manquait n'était pas la
 * correction du composant mais la vérification de son CÂBLAGE.
 *
 * ⚠️ **Ce test est DÉRIVÉ, pas écrit à la main** : il énumère les gardes présents dans
 * `src/shared/security/` et exige que chacun apparaisse dans le tableau `middleware` de
 * `src/mastra/index.ts`. Un garde ajouté demain et oublié au câblage fera rougir ce test sans
 * que personne n'ait à y penser — c'est toute la différence avec une liste recopiée, qui se
 * désynchronise au premier ajout.
 *
 * ⚠️ **Ce qu'il ne prouve PAS**, et il faut le dire : que le middleware s'exécute correctement
 * au runtime, ni qu'il assigne `c.res` plutôt que de retourner. Il prouve seulement qu'il est
 * NOMMÉ à l'endroit qui le monte. Le reste appartient aux tests de chaque garde, et au piège
 * Hono ci-dessus qu'aucun test statique ne peut voir.
 */

const ROOT = resolve(__dirname, '../../..');
const SECURITY_DIR = join(ROOT, 'src/shared/security');
const WIRING = join(ROOT, 'src/mastra/index.ts');

/**
 * Un « garde montable » est une fabrique exportée dont le nom commence par `create` et finit
 * par `Guard` ou `Middleware`. Le critère porte sur le NOM parce que c'est la convention que ce
 * dépôt suit déjà — et parce qu'un critère structurel (« rend une fonction à deux paramètres »)
 * exigerait d'exécuter le module, donc d'ouvrir des connexions au chargement.
 */
function mountableGuards(): string[] {
  const names: string[] = [];
  for (const file of readdirSync(SECURITY_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const source = readFileSync(join(SECURITY_DIR, file), 'utf-8');
    for (const match of source.matchAll(/export function (create\w*(?:Guard|Middleware))\s*\(/g)) {
      names.push(match[1]!);
    }
  }
  return [...new Set(names)].sort();
}

describe('les gardes de sécurité', () => {
  const guards = mountableGuards();
  const wiring = readFileSync(WIRING, 'utf-8');

  it('sont trouvables — sinon ce test serait vert et vide de sens', () => {
    // Le contrôle anti-faux-négatif. Si la convention de nommage change, ce test cesserait
    // silencieusement de garder quoi que ce soit.
    expect(guards.length).toBeGreaterThanOrEqual(3);
  });

  it('sont TOUS montés dans le tableau `middleware` de src/mastra/index.ts', () => {
    const middlewareBlock = wiring.slice(wiring.indexOf('middleware: ['), wiring.indexOf('cors:'));

    const orphans = guards.filter((name) => !middlewareBlock.includes(`${name}(`));

    expect(
      orphans,
      orphans.length
        ? `Garde(s) écrit(s) et jamais monté(s) : ${orphans.join(', ')}. ` +
            `Un fichier de src/shared/security/ n'est pas câblé automatiquement — ` +
            `c'était la cause du bot muet, et celle de createCallerErrorMiddleware mort ` +
            `pendant des semaines avec ses tests au vert.`
        : undefined,
    ).toEqual([]);
  });

  it("monte l'exécution d'outil par HTTP en REFUS, et avant le garde de contexte", () => {
    // ⚠️ L'ORDRE compte : refuser avant de lire et parser le corps d'une requête qu'on va de
    // toute façon rejeter. Le vérifier ici, parce que l'ordre d'un tableau ne se voit dans
    // aucun type.
    const tool = wiring.indexOf('createToolExecutionGuard(');
    const context = wiring.indexOf('createRequestContextGuard(');

    expect(tool).toBeGreaterThan(-1);
    expect(context).toBeGreaterThan(-1);
    expect(tool).toBeLessThan(context);
  });
});
