/**
 * ReDoS — le garde-fou d'entrée doit rester LINÉAIRE sur une charge adverse.
 *
 * ## Pourquoi ce fichier existe séparément
 *
 * Mesuré le 2026-08-17 : un message Slack de 8 000 caractères — exactement
 * `MAX_USER_INPUT_LENGTH`, donc accepté par la borne de longueur — de la forme
 * `<a` suivi d'espaces bloquait `wrapUserInput` pendant **106 secondes**.
 * L'étape 3 du sanitizer (neutralisation des balises XML) portait
 * `[\w-]*(?:\s+[^>]*)?\s*` : trois quantificateurs dont les classes se
 * recouvrent, donc un nombre de découpes exponentiel avant de conclure à
 * l'échec, et le drapeau `g` rejouait ce travail depuis chaque position.
 *
 * ⚠️ **Ce n'était PAS exploitable en production** — vérifié le 2026-08-17, après
 * avoir d'abord conclu l'inverse. Les deux chemins d'entrée réels neutralisent la
 * charge en amont, et par accident plutôt que par intention : côté Slack,
 * `cleanText` compacte `\s+` en une espace (le message devient `<a`, 2 caractères) ;
 * côté historique de canal, `flatten` retire `<` et `>` et borne chaque extrait à
 * 180 caractères. Rejoué avec l'ancien motif sur ces deux chemins : 0 ms.
 *
 * Le correctif reste nécessaire, et le test avec lui, pour une raison qui ne dépend
 * d'aucun appelant : `wrapUserInput` DÉCLARE accepter 8 000 caractères et se
 * présente comme la garantie de dernier recours des appelants qui n'ont pas de
 * nettoyage en amont — route HTTP, workflow, playground. Une fonction qui met
 * 106 secondes sur une entrée que sa propre borne accepte est cassée, que ses
 * appelants d'aujourd'hui la protègent ou non.
 *
 * ## Pourquoi le test porte sur les FONCTIONS et non sur les motifs
 *
 * Un test qui recopie les expressions régulières vérifierait ma liste, pas le
 * produit : le prochain motif ajouté échapperait au contrôle. On mesure donc les
 * deux portes d'entrée réelles, ce qui couvre d'avance tout motif futur.
 *
 * ⚠️ Le seuil est délibérément LARGE (2 s pour 8 000 car.). Un seuil serré
 * clignoterait sur une machine de CI chargée, et un test qui clignote finit
 * désactivé. Ce qu'on attrape ici, ce sont les régressions de plusieurs ordres
 * de grandeur — le défaut d'origine faisait 106 000 ms.
 */
import { describe, it, expect } from 'vitest';
import {
  wrapUserInput,
  wrapExternalData,
  SessionManager,
  MAX_USER_INPUT_LENGTH,
} from '../../../src/shared/security/llm-guardrail';

const sessionManager = new SessionManager({ maxSessionAge: 60000, cleanupIntervalMs: 600000 });

/** Généreux à dessein — voir l'en-tête. */
const TIME_BUDGET_MS = 2000;

/**
 * Charges adverses, chacune visant une ambiguïté de quantificateur connue du
 * module. Toutes font exactement `MAX_USER_INPUT_LENGTH` caractères : c'est la
 * plus longue entrée que la borne de longueur laisse passer.
 */
const PAYLOADS: ReadonlyArray<readonly [string, string]> = [
  // Étape 3 — balises XML. `[\w-]*` puis `(?:\s+[^>]*)?` puis `\s*` : un espace
  // pouvait être consommé par trois quantificateurs différents.
  ['balise ouverte suivie d’espaces', '<a' + ' '.repeat(MAX_USER_INPUT_LENGTH - 2)],
  ['balise ouverte suivie de tabulations', '<a' + '\t'.repeat(MAX_USER_INPUT_LENGTH - 2)],
  ['balise ouverte, attributs sans fin', '<a ' + 'x '.repeat((MAX_USER_INPUT_LENGTH - 3) / 2)],
  ['chevrons répétés', '<'.repeat(MAX_USER_INPUT_LENGTH)],
  ['chevrons alternés', '<' + '<>'.repeat((MAX_USER_INPUT_LENGTH - 1) / 2)],
  // Étape 2 — motif homoglyphe : deux classes étoilées avant un littéral.
  ['homoglyphes cyrilliques', '<' + 'ѕ'.repeat(MAX_USER_INPUT_LENGTH - 1)],
  // Instructions cachées — `\s*;?\s*` sur une longue série d’espaces.
  [
    'CSS caché, espaces après le point-virgule',
    'position:absolute' + ' '.repeat(MAX_USER_INPUT_LENGTH - 17),
  ],
  // Commentaire HTML jamais refermé.
  ['commentaire HTML non refermé', '<!--' + 'a'.repeat(MAX_USER_INPUT_LENGTH - 4)],
  // Motif d’écrasement d’instructions — fenêtre de proximité répétée.
  ['verbe d’annulation répété', 'oublie '.repeat(Math.floor(MAX_USER_INPUT_LENGTH / 7))],
];

/**
 * Batterie GÉNÉRIQUE, en plus des charges ciblées ci-dessus.
 *
 * ⚠️ C'est elle qui couvre les motifs FUTURS. Les charges ciblées visent des ambiguïtés
 * connues — donc ma liste, pas le produit. Celle-ci croise les amorces réellement utilisées
 * par les motifs du module (`<`, `system`, `ignore`, `color:`, `position:`…) avec les
 * remplissages qui font exploser un quantificateur (espaces, ponctuation, répétition d'une
 * amorce). Un motif ajouté demain qui serait super-linéaire sur l'un de ces remplissages
 * fait tomber ce test, sans que personne n'ait à y penser.
 *
 * C'est ce qui permet de désactiver les règles ReDoS d'ESLint sur `llm-guardrail.ts` : elles
 * signalaient 12 motifs, dont DEUX seulement étaient réels — et ce test les aurait attrapés
 * tous les deux, là où le bruit des dix autres avait fait ignorer l'alerte pendant des mois.
 */
const PREFIXES = [
  '<',
  '<a',
  '<!--',
  '<|',
  'system',
  'system prompt',
  'ignore',
  'oublie',
  'affiche',
  'color:',
  'position:absolute',
  'the real instruction',
  'imagine que tu es',
] as const;

const FILLERS: ReadonlyArray<readonly [string, (n: number) => string]> = [
  ['espaces', (n) => ' '.repeat(n)],
  ['tabulations', (n) => '\t'.repeat(n)],
  ['lettres', (n) => 'a'.repeat(n)],
  ['ponctuation', (n) => ':'.repeat(n)],
  ['chevrons alternés', (n) => '<>'.repeat(Math.floor(n / 2))],
  ['espaces et deux-points', (n) => ' : '.repeat(Math.floor(n / 3))],
];

describe('ReDoS — wrapUserInput reste linéaire sur une charge adverse', () => {
  it.each(PAYLOADS)('%s', (_label, payload) => {
    const started = Date.now();

    // Le verdict — encadré ou rejeté — ne nous regarde pas ici : on mesure le
    // TEMPS. Une charge adverse a parfaitement le droit d’être bloquée, elle n’a
    // pas le droit de bloquer l’instance.
    try {
      wrapUserInput(payload.slice(0, MAX_USER_INPUT_LENGTH), 'redos-user', sessionManager);
    } catch {
      /* SecurityBlockError est une issue légitime. */
    }

    expect(Date.now() - started).toBeLessThan(TIME_BUDGET_MS);
  });
});

describe('ReDoS — batterie générique (couvre les motifs à venir)', () => {
  it.each(PREFIXES)('amorce « %s », tous remplissages', (prefix) => {
    // Un seul `it` par amorce : 13 × 6 = 78 charges de 8 000 caractères, et les déclarer une
    // par une rendrait la sortie de vitest illisible pour un gain nul.
    for (const [, fill] of FILLERS) {
      const payload = (prefix + fill(MAX_USER_INPUT_LENGTH)).slice(0, MAX_USER_INPUT_LENGTH);
      const started = Date.now();

      try {
        wrapUserInput(payload, 'redos-matrix', sessionManager);
      } catch {
        /* un blocage est une issue légitime — seul le TEMPS est en cause ici */
      }

      expect(Date.now() - started).toBeLessThan(TIME_BUDGET_MS);
    }
  });
});

describe('ReDoS — wrapExternalData reste linéaire sur une charge adverse', () => {
  // Six fois plus long : `wrapExternalData` tronque à 50 000 caractères, pas à 8 000. Son
  // seul appelant actuel (`wrapRetrievedContent`) ne lui livre jamais rien d'approchant —
  // `flatten` borne chaque extrait à 180 caractères et retire les chevrons — mais la borne
  // de 50 000 est ce que la fonction PROMET, et c'est sur sa promesse qu'on la mesure.
  const EXTERNAL_LENGTH = 50000;

  /**
   * ⚠️ BUDGET SERRÉ ICI, ET C'EST DÉLIBÉRÉ — 2026-08-22.
   *
   * Le budget global de 2 s protège la batterie générique du bruit d'une machine de CI
   * chargée. Mais un défaut QUADRATIQUE mesuré à 1 357 ms passait sous ce seuil : le
   * garde-fou était vert et ne gardait rien. Les charges ci-dessous s'exécutent en 0 à 2 ms
   * une fois le motif linéaire — 200 fois sous ce plafond. On garde donc une marge énorme
   * contre le bruit tout en attrapant réellement la classe de défaut.
   */
  const EXTERNAL_BUDGET_MS = 400;

  it.each([
    ['balise ouverte suivie d’espaces', '<a' + ' '.repeat(EXTERNAL_LENGTH - 2)],
    ['chevrons alternés', '<' + '<>'.repeat((EXTERNAL_LENGTH - 1) / 2)],
    // ⚠️ TROU DE COUVERTURE, trouvé le 2026-08-22. Les deux charges ci-dessus laissaient
    // `validateDelimiterIntegrity` intact : son motif porte `<\s*\/?\s*(?:user_input|…)`,
    // deux quantificateurs de BLANCS séparés par un `/` optionnel, donc une espace pouvait
    // être consommée par l'un ou par l'autre — N²/2 découpes. Or `<a` commence par une
    // lettre, qui n'est pas un blanc : le motif ne s'amorçait jamais.
    // Mesuré avant correctif : 54 ms à 8 k, 258 ms à 20 k, 1 841 ms à 50 k.
    // Atteignable par un simple DM : `archiveChannelMessage` stocke le texte BRUT, sans
    // `cleanText` et sans borne de longueur, et le rideau à faits en concatène cinq.
    ['chevron nu suivi d’espaces', '<' + ' '.repeat(EXTERNAL_LENGTH - 1)],
    ['chevron et barre oblique suivis d’espaces', '</' + ' '.repeat(EXTERNAL_LENGTH - 2)],
  ])('%s', (_label, payload) => {
    const started = Date.now();

    try {
      wrapExternalData(payload, 'redos-external', sessionManager);
    } catch {
      /* idem */
    }

    expect(Date.now() - started).toBeLessThan(EXTERNAL_BUDGET_MS);
  });
});
