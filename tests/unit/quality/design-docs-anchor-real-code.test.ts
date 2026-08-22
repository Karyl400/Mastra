import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const DOCS = join(ROOT, 'docs/conception');

/*
 * Le POURQUOI a quitté `src/` le 2026-08-21 pour `docs/conception/` — une page par feature,
 * chaque entrée ancrée sur la DÉCLARATION qu'elle précédait. `comments-live-in-docs.test.ts`
 * garde le sens ALLER (un commentaire ne revient pas dans le code). Rien ne gardait le sens
 * RETOUR : une ancre peut désigner du code supprimé, et personne ne le voit.
 *
 * C'est le risque que le dépôt s'est écrit à lui-même : « sur onze affirmations fausses,
 * onze étaient dans la documentation à distance ». Une ancre orpheline est le premier degré
 * de cette dérive — elle ne ment pas encore, mais elle ne désigne plus rien.
 *
 * ─── STRATÉGIE DE NORMALISATION ──────────────────────────────────────────────────────────
 *
 * On ne compare pas des lignes : Prettier reformate les déclarations (un appel tenant sur une
 * ligne dans l'ancre est éclaté sur cinq dans le code, avec une virgule finale ajoutée). On
 * réduit donc les DEUX côtés à une forme sans blancs :
 *   1. tous les blancs supprimés — un saut de ligne, un espace et une indentation deviennent
 *      la même absence, donc le découpage de Prettier n'est plus visible ;
 *   2. toute virgule précédant une fermeture (`)`, `]`, `}`, `>`) supprimée, en boucle jusqu'à
 *      point fixe — la virgule finale de Prettier n'existe que dans la forme multi-ligne ;
 *   3. les virgules en fin d'ancre supprimées, pour la même raison vue de l'autre bord ;
 *   4. ⚠️ **les trois guillemets — `'`, `"` et l'accent grave — ramenés au même caractère.**
 *      Ce n'est pas une commodité : l'extraction du 2026-08-21 a dû REMPLACER les accents
 *      graves des littéraux de gabarit par des apostrophes, sans quoi l'ancre aurait cassé
 *      la travée de code markdown qui la contient. Une dizaine d'ancres portant un `${…}`
 *      étaient donc structurellement incapables de correspondre à leur code, et ce test les
 *      dénonçait comme orphelines alors que le code n'avait pas bougé d'une ligne. Un test
 *      qui accuse à tort use la confiance aussi sûrement qu'un test qui se tait.
 * Puis on cherche la forme réduite de l'ancre comme SOUS-CHAÎNE de la forme réduite de tout
 * `src/`, concaténée.
 *
 * ─── CE QUE CE TEST NE VÉRIFIE PAS ───────────────────────────────────────────────────────
 *
 * — **Il ne vérifie pas le FICHIER.** Une ancre est cherchée dans tout `src/`, pas dans le
 *   fichier annoncé par le `## \`chemin\`` qui la surplombe. Ces en-têtes sont eux-mêmes peu
 *   fiables : l'extraction a attribué des séries entières d'entrées au dernier chemin vu.
 *   Une déclaration DÉPLACÉE d'un fichier à l'autre passe donc au vert alors que sa page la
 *   range toujours au mauvais endroit.
 * — **Il ne vérifie pas l'UNICITÉ ni la POSITION.** `return {` ou `tools: {},` existent des
 *   dizaines de fois : ces ancres-là seront vertes quoi qu'il arrive. Le test attrape la
 *   disparition d'un symbole nommé, pas le déplacement d'une entrée sous la mauvaise ligne.
 * — **La suppression des blancs peut souder deux jetons** (`export function foo` devient
 *   `exportfunctionfoo`) : deux textes différents peuvent se réduire à la même forme. Le test
 *   penche donc du côté PERMISSIF — il peut manquer une orpheline, il n'invente pas d'orphelin.
 * — **Il ne dit rien de la JUSTESSE du texte.** Une ancre vivante peut surplomber une
 *   explication devenue fausse. Aucun test ne sait lire cela ; seule la règle du dépôt le peut
 *   (« quand une décision change, sa page change dans le MÊME commit »).
 */

function normalize(code: string): string {
  let out = code.replace(/\s+/g, '').replace(/['"`]/g, '"');
  let previous: string;
  do {
    previous = out;
    out = out.replace(/,(?=[)\]}>])/g, '');
  } while (out !== previous);
  return out.replace(/,+$/, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface Anchor {
  readonly page: string;
  readonly line: number;
  readonly code: string;
}

const ANCHOR = /^\*\*Avant `(.+)`\*\*$/;

function anchorsOf(page: string, text: string): Anchor[] {
  const found: Anchor[] = [];
  text.split('\n').forEach((line, index) => {
    const match = ANCHOR.exec(line);
    if (match) found.push({ page, line: index + 1, code: match[1]! });
  });
  return found;
}

function readAnchors(): Anchor[] {
  return readdirSync(DOCS)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .flatMap((f) => anchorsOf(f, readFileSync(join(DOCS, f), 'utf8')));
}

function readSource(): string {
  return walk(join(ROOT, 'src'))
    .map((f) => normalize(readFileSync(f, 'utf8')))
    .join('\n');
}

function orphansIn(anchors: readonly Anchor[], source: string): Anchor[] {
  return anchors.filter((a) => !source.includes(normalize(a.code)));
}

/*
 * DETTE RECENSÉE — et rien d'autre.
 *
 * Chaque entrée est une ancre dont on SAIT qu'elle ne désigne plus rien, et dont le texte
 * n'a pas encore trouvé de point d'attache vivant. Le second test interdit d'en garder une
 * qui aurait cessé d'être orpheline : la liste ne peut que RÉTRÉCIR. Ce n'est pas une
 * permission d'en ajouter — c'est l'inventaire de ce qui reste à réancrer ou à jeter.
 */
const DETTE: ReadonlyArray<{ readonly code: string; readonly motif: string }> = [
  {
    code: 'const member = directory ? await directory.findByEmail(normalizedEmail) : null;',
    motif: 'chemin de résolution par email remanié depuis',
  },
  {
    code: 'export function projectExcerpts(all: readonly ConversationExcerpt[]): {',
    motif: "projection d'extraits remaniée par la saillance et la couverture",
  },
  {
    code: "description: 'Enregistre un rappel daté. Aucun automate ne le reprend : rien ne part seul.',",
    motif: '⚠️ MENT DEPUIS LE CRON DU 2026-08-21 — un automate le reprend bel et bien',
  },
  {
    code: 'scheduledLabel: frenchFullLabel(new Date(when), DISPLAY_TIMEZONE),',
    motif: "le tool ne rend plus l'heure demandée, seulement `deliveredOn`",
  },
  {
    code: 'function safeNotificationBody(',
    motif: 'assainissement sortant déplacé dans `outbound-text.ts`',
  },
  {
    code: 'await emailProvider.sendEmail(destination, data.subject, textEmailBody(safe.text));',
    motif: "chemin d'envoi email remanié",
  },
  {
    code: 'body: safe.text,',
    motif: "chemin d'envoi email remanié",
  },
  {
    code: 'const KNOWN_AGENT_IDS: ReadonlySet<string> = new Set([',
    motif: "la liste des agents est désormais dérivée d'`AGENT_TOOLS`",
  },
  {
    code: "const NON_DELIVERING_TOOL_NAMES: ReadonlySet<string> = new Set(['scheduleReminder']);",
    motif:
      '⚠️ détecteur retourné par le cron du 2026-08-21 : la condition porte désormais sur « aucun outil agissant »',
  },
  {
    code: 'export function onlyNonDeliveringTools(toolCalls: readonly string[]): boolean {',
    motif: '⚠️ même cause : le détecteur a changé de condition avec le câblage',
  },
  {
    code: 'const ENCLITIC = "(?:(?:le|la|lui|les|leur|vous) |t\')";',
    motif: "motif de fausse promesse élargi (l'élidé `l'` manquait)",
  },
  {
    code: 'logFields: ({ isDirectMessage }) => ({ isDirectMessage }),',
    motif: 'table des court-circuits remaniée',
  },
  {
    code: 'limit: 90_000,',
    motif: 'budget de débit remanié',
  },
  {
    code: 'profileRepository?: { findByEmail(email: string): Promise<ProfileSnapshot | null> } | null;',
    motif: 'signature des options du handler remaniée',
  },
  {
    code: 'private async chargeModelBudget(slackUserId: string | undefined): Promise<void> {',
    motif: 'débit du budget modèle déplacé après les court-circuits',
  },
  {
    code: 'const { channel, threadTs, isDirectMessage } = ctx;',
    motif: 'contexte de message remanié',
  },
  {
    code: 'const registeredWithoutDelivery = toolCalls !== null && onlyNonDeliveringTools(toolCalls);',
    motif: '⚠️ même cause que `onlyNonDeliveringTools` : condition changée par le cron',
  },
  {
    code: 'appendNotes([excerptCoverage, pendingEmailReminder, onboardingReminder]),',
    motif: 'liste des notes accolées élargie',
  },
  {
    code: 'await this.chargeModelBudget(user);',
    motif: "site d'appel déplacé",
  },
  {
    code: 'void this.warnManagersOfTopRoleClaim(input.user, answers.position);',
    motif: 'rend désormais le nom du porteur, pour le dire au déclarant',
  },
  {
    code: "if (message.includes('user_not_found') || message.includes('users_not_found')) {",
    motif: 'décodage des erreurs Slack remanié',
  },
  {
    code: 'function isSlackError(err: unknown, code: string): boolean {',
    motif: 'décodage des erreurs Slack remanié',
  },
  {
    code: "knowledgeAgent: ['getUserConversations', 'getChannelHistory', 'findExpertise'],",
    motif: 'câblage des outils modifié depuis',
  },
  {
    code: 'export const AGENT_STYLE_BLOCK = `STYLE : collègue, français, phrases courtes, ton neutre, sans ',
    motif: "bloc STYLE réécrit le 2026-08-21 avec le prénom de l'agent",
  },
  {
    code: 'const DISTRESS_PHRASES: readonly string[] = [',
    motif: 'scindé en `SELF_HARM_*` / `AGGRESSION_*` le 2026-08-21',
  },
  {
    code: '"Si c\'est urgent : *0800 0787 746* (SURPIN, gratuit, 24h/24, partout au Nigeria), ou le " +',
    motif: '⚠️ numéro NIGÉRIAN — les lignes sont béninoises (117/112) depuis le 2026-08-21',
  },
  {
    code: "'Pour une situation au travail — harcèlement, conflit, souffrance — tu peux en parler à ' +",
    motif: "message d'agression réécrit lors de la séparation des deux cas",
  },
  {
    code: 'const plural = count > 1;',
    motif: 'formulation des réponses variées remaniée',
  },
  {
    code: "export const GROQ_MODEL_ID = 'openai/gpt-oss-120b';",
    motif: "⚠️ Groq n'est plus le primaire depuis le 2026-08-20 — Gemini l'est",
  },
  {
    code: "export const MISTRAL_MODEL_ID = 'mistral-large-latest';",
    motif: 'chaîne de repli passée à trois maillons le 2026-08-20',
  },
  {
    code: 'export const PRIMARY_MODEL_ID = `groq/${GROQ_MODEL_ID}`;',
    motif: "⚠️ Groq n'est plus le primaire depuis le 2026-08-20 — Gemini l'est",
  },
  {
    code: 'export const FALLBACK_MODEL_ID = `mistral/${MISTRAL_MODEL_ID}`;',
    motif: 'chaîne de repli passée à trois maillons le 2026-08-20',
  },
  {
    code: 'sanitized = sanitized.replace(/<\\/?\\s*[a-zA-Z_][^>]*>/g, (match) => {',
    motif: 'motif resserré le 2026-08-22 pour fermer un ReDoS quadratique',
  },
];

describe('les ancres de docs/conception/ désignent du code qui existe', () => {
  const anchors = readAnchors();
  const source = readSource();

  it('lit réellement les pages et le code — anti faux-négatif', () => {
    expect(anchors.length).toBeGreaterThan(2400);
    expect(source.length).toBeGreaterThan(200_000);
  });

  it('sait reconnaître une ancre morte et une ancre vivante — anti faux-négatif', () => {
    const fabriquee = anchorsOf(
      'faux.md',
      '**Avant `export function ceSymboleNExistePas(): void {`**\n',
    );
    expect(fabriquee).toHaveLength(1);
    expect(orphansIn(fabriquee, source)).toHaveLength(1);

    const vivante = anchorsOf('faux.md', '**Avant `export function selectWindow(`**\n');
    expect(vivante).toHaveLength(1);
    expect(orphansIn(vivante, source)).toHaveLength(0);
  });

  it('tolère le reformatage de Prettier — anti faux-négatif', () => {
    const multiligne = normalize('export function f(\n  a: string,\n  b: number,\n): void {');
    expect(multiligne).toBe(normalize('export function f(a: string, b: number): void {'));
    expect(normalize("defaultStyle: { font: 'Roboto' },")).toBe(
      normalize("defaultStyle: {\n  font: 'Roboto',\n}"),
    );
  });

  it('aucune ancre ne désigne du code disparu', () => {
    const toleres = new Set(DETTE.map((d) => normalize(d.code)));
    const orphelines = orphansIn(anchors, source).filter((a) => !toleres.has(normalize(a.code)));

    expect(
      orphelines.map((o) => `${o.page}:${o.line}  ${o.code}`),
      orphelines.length
        ? `Ces ancres ne désignent plus aucune ligne de src/ — le code a été supprimé ou ` +
            `renommé sans que sa page bouge dans le même commit.\n` +
            `Deux issues, jamais une troisième : RÉANCRER l'entrée sur la déclaration vivante ` +
            `qui porte encore la décision, ou la SUPPRIMER si le code a réellement disparu. ` +
            `Une entrée porte le POURQUOI d'une décision, parfois payé par un incident de ` +
            `production : la jeter est un geste, pas un nettoyage.`
        : undefined,
    ).toEqual([]);
  });
});

describe('la dette recensée ne peut que rétrécir', () => {
  it('chaque exception correspond encore à une ancre réellement orpheline', () => {
    const anchors = readAnchors();
    const source = readSource();
    const orphelines = new Set(orphansIn(anchors, source).map((o) => normalize(o.code)));

    const perimees = DETTE.filter((d) => !orphelines.has(normalize(d.code)));

    expect(
      perimees.map((d) => d.code),
      perimees.length
        ? `Ces exceptions ne correspondent plus à une ancre orpheline : soit l'ancre a été ` +
            `réancrée ou supprimée, soit le code est revenu. Les retirer de DETTE — une ` +
            `exception qui ne protège plus rien finit par protéger autre chose.`
        : undefined,
    ).toEqual([]);
  });

  it('chaque exception porte un motif écrit', () => {
    expect(DETTE.filter((d) => d.motif.trim().length < 20).map((d) => d.code)).toEqual([]);
  });
});
