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
 * Ce n'est pas une gêne de performance, c'est un **déni de service à distance** :
 * l'event loop de Node est mono-thread, et Vercel Fluid Compute réutilise une
 * instance entre requêtes concurrentes. Un seul DM gelait donc l'instance —
 * toutes conversations confondues — bien au-delà des 60 s de `maxDuration`.
 * Aucune authentification n'était requise au-delà de pouvoir écrire au bot.
 *
 * `wrapExternalData` tronque à 50 000 caractères et passe par le MÊME sanitizer :
 * un message posté dans un canal, relu par `getChannelHistory`, atteignait donc
 * la même faille avec une charge six fois plus longue.
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

describe('ReDoS — wrapExternalData reste linéaire sur une charge adverse', () => {
  // Six fois plus long : `wrapExternalData` tronque à 50 000 caractères, pas à
  // 8 000. Le contenu vient d’un canal Slack — donc de n’importe qui.
  const EXTERNAL_LENGTH = 50000;

  it.each([
    ['balise ouverte suivie d’espaces', '<a' + ' '.repeat(EXTERNAL_LENGTH - 2)],
    ['chevrons alternés', '<' + '<>'.repeat((EXTERNAL_LENGTH - 1) / 2)],
  ])('%s', (_label, payload) => {
    const started = Date.now();

    try {
      wrapExternalData(payload, 'redos-external', sessionManager);
    } catch {
      /* idem */
    }

    expect(Date.now() - started).toBeLessThan(TIME_BUDGET_MS);
  });
});
