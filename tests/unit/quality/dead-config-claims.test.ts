import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « Config morte à purger » est une INSTRUCTION, pas une observation
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `CLAUDE.md` tient une liste de variables d'environnement déclarées mortes et « à purger ».
 * Le 2026-08-21, un audit y a trouvé **`GOOGLE_GEMINI_API_KEY`** — c'est-à-dire la clé du
 * modèle PRIMAIRE (`PRIMARY_MODEL_ID` vaut `google/gemini-3.5-flash` depuis le 2026-08-20).
 *
 * Ce qui rend ce défaut coûteux n'est pas l'erreur, c'est sa FORME :
 *
 * 1. **C'est une phrase qui demande d'agir.** Les autres énoncés faux de ce dépôt décrivaient
 *    un état ; celui-ci prescrivait un geste, et le geste était destructeur.
 * 2. **L'appliquer n'aurait produit AUCUN symptôme.** La chaîne de repli aurait pris le
 *    relais, le bot aurait répondu — jusqu'à ce que le quota JOURNALIER de Groq, la borne que
 *    le passage à Gemini existe précisément pour lever, remorde. Une panne qui ne se distingue
 *    pas du fonctionnement normal est exactement ce que ce dépôt combat partout ailleurs.
 * 3. **Rien ne la recalculait.** C'est la famille « le commentaire énonce une propriété
 *    GLOBALE que rien ne recalcule », déjà nommée pour `READ_ONLY_TOOL_NAMES` et
 *    `onlyNonDeliveringTools`.
 *
 * Ce test DÉRIVE la vérification : il lit la liste dans `CLAUDE.md` et va voir dans le code.
 * Une variable ne peut plus être déclarée morte tant que quelque chose la lit.
 *
 * ⚠️ Le sens est volontairement UNIQUE. On ne vérifie pas l'inverse (« toute variable non lue
 * doit figurer dans la liste ») : `.env.example` porte des variables purement documentaires, et
 * `env-example-completeness.test.ts` couvre déjà ce versant. Ici on ne garde qu'une chose — que
 * la doc ne demande jamais de supprimer quelque chose de vivant.
 */

const ROOT = resolve(__dirname, '../../..');
const CLAUDE_MD = join(ROOT, 'CLAUDE.md');

/** Les répertoires où une lecture compte comme « cette variable est vivante ». */
const LIVE_DIRS = ['src', 'scripts'];

function collectFiles(dir: string, exts: readonly string[], out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectFiles(full, exts, out);
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

/**
 * Extrait les noms de variables du paragraphe « Config morte … à purger ».
 *
 * Le paragraphe est reconnu par sa phrase d'ouverture, puis on lit jusqu'à la ligne vide.
 * Volontairement littéral : si quelqu'un reformule la phrase, ce test ne trouvera plus la liste
 * et le rendra visible par l'assertion de non-vacuité ci-dessous, plutôt que de se taire.
 */
function deadConfigClaims(markdown: string): string[] {
  const start = markdown.indexOf('Config morte');
  if (start === -1) return [];
  const paragraph = markdown.slice(start).split('\n\n')[0] ?? '';
  return [...paragraph.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)].map((m) => m[1]!);
}

describe('la liste « config morte à purger » de CLAUDE.md', () => {
  const markdown = readFileSync(CLAUDE_MD, 'utf-8');
  const claimed = deadConfigClaims(markdown);

  it('est trouvable — sans quoi ce garde-fou serait vert et vide de sens', () => {
    // Le contrôle anti-faux-négatif que ce dépôt applique à ses autres tests de qualité :
    // un test qui ne trouve rien à vérifier passe toujours.
    expect(claimed.length).toBeGreaterThan(0);
  });

  it('ne nomme aucune variable que `src/` ou `scripts/` lit encore', () => {
    const files = LIVE_DIRS.flatMap((d) =>
      collectFiles(join(ROOT, d), ['.ts', '.mts', '.mjs', '.js']),
    );
    const corpus = files.map((f) => readFileSync(f, 'utf-8')).join('\n');

    const stillRead = claimed.filter((name) => corpus.includes(name));

    expect(
      stillRead,
      stillRead.length
        ? `CLAUDE.md demande de purger ${stillRead.join(', ')} — or le code les lit encore. ` +
            `Purger une variable vivante casse le produit, et la panne peut être SILENCIEUSE ` +
            `(c'est ce qui serait arrivé à GOOGLE_GEMINI_API_KEY, clé du modèle primaire). ` +
            `Vérifier le code avant de corriger la liste, jamais l'inverse.`
        : undefined,
    ).toEqual([]);
  });
});

/**
 * Le pendant du constat : la clé du modèle primaire est bien lue, et elle porte bien le
 * PRIMAIRE. Sans cette seconde assertion, le test ci-dessus resterait vert si quelqu'un
 * retirait à la fois la variable de la liste ET son usage du code.
 */
describe('la clé du modèle primaire', () => {
  it('est lue par la chaîne de modèles, et Gemini y est le premier maillon', async () => {
    const chain = readFileSync(join(ROOT, 'src/shared/llm/model-fallback.ts'), 'utf-8');
    expect(chain).toContain('GOOGLE_GEMINI_API_KEY');

    const { PRIMARY_MODEL_ID } = await import('../../../src/shared/llm/model-fallback');
    expect(PRIMARY_MODEL_ID.startsWith('google/')).toBe(true);
  });
});
