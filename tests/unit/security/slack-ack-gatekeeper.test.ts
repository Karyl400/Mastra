import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  verifySlackSignature,
  computeSlackSignature,
} from '../../../src/shared/security/slack-signature';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LA VÉRIFICATION HMAC EST DUPLIQUÉE, ET LA COPIE NON TESTÉE TOURNAIT EN PREMIER
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `src/shared/security/slack-signature.ts` est couvert, et c'est sur lui que porte le seuil de
 * couverture de `vitest.config.ts`. Mais depuis le 2026-08-19, ce n'est PLUS lui qui fronte
 * `/slack/events` : le PORTIER D'ACK (`scripts/slack-ack-function/index.mjs`, seconde fonction
 * Vercel sans aucune dépendance) réimplémente la même vérification — `createHmac`,
 * `timingSafeEqual`, fenêtre de 300 s — et AUCUN test du dépôt ne le référençait.
 * `grep -rln 'slack-ack-function' tests/` rendait zéro ligne le 2026-08-20.
 *
 * La frontière de sécurité réelle reste la route applicative, qui revérifie sur le corps
 * réexpédié à l'identique. Mais le portier décide, LUI, ce qui est réexpédié : une régression
 * de son côté ouvre une amplification à quiconque connaît l'URL, ou — bien pire et bien plus
 * silencieux — refuse tout et rend le bot muet avec des journaux applicatifs vides, puisque
 * rien n'arrive jamais jusqu'à eux.
 *
 * Le second `describe` est la vraie valeur du fichier : un test de CONTRAT qui confronte les
 * deux implémentations sur le même corps, le même secret et le même horodatage. C'est ce qui
 * empêche les deux copies de diverger sans que personne ne le voie.
 */

const SECRET = 's3cr3t-de-signature-slack';
const GATEKEEPER = new URL('../../../scripts/slack-ack-function/index.mjs', import.meta.url).href;

type GatekeeperHandler = (req: unknown, res: unknown) => Promise<void>;

async function loadGatekeeper(): Promise<GatekeeperHandler> {
  // Import DYNAMIQUE par URL calculée : `tsconfig.json` n'active pas `allowJs`, donc un import
  // statique d'un `.mjs` sans déclaration ferait rougir `npm run typecheck`.
  const module = (await import(/* @vite-ignore */ GATEKEEPER)) as { default: GatekeeperHandler };
  return module.default;
}

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

interface CallOptions {
  body?: string;
  timestamp?: string | undefined;
  signature?: string | undefined;
  secret?: string | undefined;
  url?: string;
  method?: string;
  host?: string;
}

/** Signature Slack calculée à la main, sans passer par le module qu'on veut confronter. */
function signWith(secret: string, timestamp: string, body: string): string {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

let fetchSpy: ReturnType<typeof vi.fn>;

async function callGatekeeper(options: CallOptions = {}): Promise<FakeResponse> {
  const body = options.body ?? '{"type":"event_callback"}';
  const timestamp = 'timestamp' in options ? options.timestamp : String(nowSeconds());
  const signature =
    'signature' in options ? options.signature : signWith(SECRET, String(timestamp ?? ''), body);

  if ('secret' in options) {
    if (options.secret === undefined) delete process.env.SLACK_SIGNING_SECRET;
    else process.env.SLACK_SIGNING_SECRET = options.secret;
  } else {
    process.env.SLACK_SIGNING_SECRET = SECRET;
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host: options.host ?? 'kisso.vercel.app',
  };
  if (timestamp !== undefined) headers['x-slack-request-timestamp'] = timestamp;
  if (signature !== undefined) headers['x-slack-signature'] = signature;

  const req = Object.assign(Readable.from([Buffer.from(body, 'utf8')]), {
    method: options.method ?? 'POST',
    url: options.url ?? '/slack/events',
    headers,
  });

  const response: FakeResponse = { statusCode: 0, headers: {}, body: '' };
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string) {
      response.headers[name] = value;
    },
    end(payload?: string) {
      response.statusCode = res.statusCode;
      response.body = payload ?? '';
    },
  };

  const handler = await loadGatekeeper();
  await handler(req, res);
  return response;
}

beforeEach(() => {
  // ⚠️ Le portier réexpédie vraiment. Sans cette doublure, chaque test accepté partirait sur le
  // réseau vers `https://kisso.vercel.app/internal/slack/events`.
  fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
  // Le portier journalise en `error` quand `waitUntil` est absent — c'est le cas hors Vercel,
  // donc à chaque test. On le tait sans le désarmer : un test plus bas l'observe.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env.SLACK_SIGNING_SECRET = SECRET;
});

describe('Portier d’ACK Slack — vérification de signature', () => {
  it('ACCEPTE une requête correctement signée et la réexpédie au chemin interne', async () => {
    const response = await callGatekeeper();

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Le chemin interne existe pour que le routage Vercel ne renvoie pas la requête au portier :
    // ce serait une boucle, et le symptôme serait un bot muet.
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://kisso.vercel.app/internal/slack/events',
    );
  });

  it('REFUSE une signature invalide en 401, et ne réexpédie RIEN', async () => {
    const response = await callGatekeeper({ signature: 'v0=' + 'a'.repeat(64) });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).reason).toBe('signature_mismatch');
    // Réexpédier un corps non signé offrirait une amplification à quiconque connaît l'URL.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('REFUSE une signature valide portant sur un AUTRE corps (corps altéré en vol)', async () => {
    const timestamp = String(nowSeconds());
    const response = await callGatekeeper({
      body: '{"type":"event_callback","text":"altéré"}',
      timestamp,
      signature: signWith(SECRET, timestamp, '{"type":"event_callback"}'),
    });

    expect(response.statusCode).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('REFUSE en 401 quand l’en-tête de signature manque', async () => {
    const response = await callGatekeeper({ signature: undefined });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).reason).toBe('missing_signature_headers');
  });

  it('REFUSE en 401 quand l’en-tête d’horodatage manque', async () => {
    const response = await callGatekeeper({
      timestamp: undefined,
      signature: 'v0=' + 'a'.repeat(64),
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).reason).toBe('missing_signature_headers');
  });

  it('REFUSE en 401 quand le secret est ABSENT — fail-closed, jamais fail-open', async () => {
    // ⚠️ C'est LE test qui compte le plus dans ce bloc. Une variable d'environnement oubliée sur
    // une seconde fonction Vercel est l'oubli le plus banal qui soit, et un portier qui, faute
    // de secret, laisserait tout passer transformerait cet oubli en endpoint public.
    const response = await callGatekeeper({ secret: undefined });

    expect(response.statusCode).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('REFUSE un horodatage de plus de 300 s dans le PASSÉ', async () => {
    const timestamp = String(nowSeconds() - 301);
    const response = await callGatekeeper({ timestamp });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).reason).toBe('stale_timestamp');
  });

  it('REFUSE un horodatage de plus de 300 s dans le FUTUR — écart mesuré en VALEUR ABSOLUE', async () => {
    // Une soustraction non absolue rendrait un nombre NÉGATIF, jamais supérieur au seuil : toute
    // requête postdatée passerait, et la fenêtre anti-rejeu ne servirait plus à rien dans un sens.
    const timestamp = String(nowSeconds() + 301);
    const response = await callGatekeeper({ timestamp });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).reason).toBe('stale_timestamp');
  });

  it('ACCEPTE aux deux bords de la fenêtre (−299 s et +299 s)', async () => {
    expect((await callGatekeeper({ timestamp: String(nowSeconds() - 299) })).statusCode).toBe(200);
    expect((await callGatekeeper({ timestamp: String(nowSeconds() + 299) })).statusCode).toBe(200);
  });

  it('REFUSE un horodatage non numérique sans jamais LEVER', async () => {
    // `Number('bonjour')` vaut NaN ; `NaN > 300` est FAUX. Sans la garde `Number.isFinite`, un
    // horodatage arbitraire franchirait la fenêtre de fraîcheur.
    const response = await callGatekeeper({ timestamp: 'bonjour' });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).reason).toBe('stale_timestamp');
  });

  it('NE LÈVE PAS sur une signature de longueur différente — `timingSafeEqual` lève, lui', async () => {
    // ⚠️ `crypto.timingSafeEqual` jette `RangeError` si les deux tampons n'ont pas la même
    // taille. Un portier qui laisse remonter cette exception rend un 500 (ou rien du tout) là où
    // Slack attend un verdict : la comparaison DOIT écarter les longueurs inégales elle-même.
    for (const signature of ['v0=abc', '', 'v0=' + 'a'.repeat(4096), 'nimportequoi']) {
      const response = await callGatekeeper({ signature });
      expect(response.statusCode).toBe(401);
    }
  });

  it('répond LUI-MÊME au `url_verification`, et ne le réexpédie pas', async () => {
    // ⚠️ Réexpédier produirait un 200 VIDE : Slack attend le `challenge` DANS la réponse, et
    // refuserait l'URL. Ce n'est pas un détail de confort — c'est l'endpoint entier qui
    // n'existerait jamais.
    const body = JSON.stringify({ type: 'url_verification', challenge: 'c3-abc-XYZ' });
    const response = await callGatekeeper({ body, url: '/slack/events' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ challenge: 'c3-abc-XYZ' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ne répond JAMAIS au `url_verification` sans signature valide', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'c3-abc-XYZ' });
    const response = await callGatekeeper({ body, signature: 'v0=' + 'b'.repeat(64) });

    expect(response.statusCode).toBe(401);
  });

  it('réexpédie un corps ILLISIBLE plutôt que de le juger — la route applicative le refusera', async () => {
    const response = await callGatekeeper({ body: 'ceci-nest-pas-du-json' });

    expect(response.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('route les interactions vers le chemin interne des interactions', async () => {
    await callGatekeeper({ url: '/slack/interactions' });

    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://kisso.vercel.app/internal/slack/interactions',
    );
  });

  it('tire l’hôte de réexpédition de la REQUÊTE, jamais d’une variable', async () => {
    // Sur un déploiement de prévisualisation, une URL de production ferait traiter l'événement
    // par le mauvais code — et le symptôme serait « ça marche ».
    await callGatekeeper({ host: 'kisso-preview-42.vercel.app' });

    expect(String(fetchSpy.mock.calls[0][0])).toContain('kisso-preview-42.vercel.app');
  });

  it('réexpédie le corps À L’IDENTIQUE, signature et horodatage compris', async () => {
    // La route applicative revérifie le HMAC sur ce corps : le moindre reformatage (un
    // `JSON.parse` suivi d'un `JSON.stringify`) invaliderait la signature et rendrait le bot
    // muet, sans qu'aucune erreur ne soit levée nulle part.
    const body = '{"type":"event_callback",  "spacing":"préservé"}';
    const timestamp = String(nowSeconds());
    await callGatekeeper({ body, timestamp });

    const init = fetchSpy.mock.calls[0][1] as { body: string; headers: Record<string, string> };
    expect(init.body).toBe(body);
    expect(init.headers['x-slack-request-timestamp']).toBe(timestamp);
    expect(init.headers['x-slack-signature']).toBe(signWith(SECRET, timestamp, body));
  });

  it('propage les en-têtes de RÉESSAI — sans eux, la déduplication perdrait son signal', async () => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    const body = '{"type":"event_callback"}';
    const timestamp = String(nowSeconds());
    const req = Object.assign(Readable.from([Buffer.from(body, 'utf8')]), {
      method: 'POST',
      url: '/slack/events',
      headers: {
        host: 'kisso.vercel.app',
        'content-type': 'application/json',
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signWith(SECRET, timestamp, body),
        'x-slack-retry-num': '1',
        'x-slack-retry-reason': 'http_timeout',
      },
    });
    const res = { statusCode: 0, setHeader() {}, end() {} };

    await (
      await loadGatekeeper()
    )(req, res);

    const init = fetchSpy.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['x-slack-retry-num']).toBe('1');
    expect(init.headers['x-slack-retry-reason']).toBe('http_timeout');
  });

  it('refuse toute méthode autre que POST, AVANT même de lire le corps', async () => {
    const response = await callGatekeeper({ method: 'GET' });

    expect(response.statusCode).toBe(405);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('journalise en `error` quand le travail est DÉTACHÉ (waitUntil indisponible)', async () => {
    // Hors Vercel c'est le cas normal ; en production ce serait la ligne à chercher si le bot
    // recommençait à ne plus répondre avec des ACK impeccables.
    await callGatekeeper();

    const lignes = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[0]))
      .join('\n');
    expect(lignes).toContain('work is detached');
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * TEST DE CONTRAT — LES DEUX IMPLÉMENTATIONS DOIVENT RENDRE LE MÊME VERDICT
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Même corps, même secret, même horodatage. Le portier accepte (200) ou refuse (401) ;
 * `verifySlackSignature` rend `valid`. Toute divergence signifie qu'une requête est acquittée
 * par le portier puis refusée par la route applicative — Slack a reçu son 200, et l'événement
 * disparaît sans aucune trace côté utilisateur — ou l'inverse.
 *
 * ⚠️ Les motifs des refus, eux, NE SONT PAS identiques et ne peuvent pas l'être : le portier
 * fond `missing_signing_secret` dans `missing_signature_headers`, et `invalid_timestamp` dans
 * `stale_timestamp`. C'est le VERDICT qui est le contrat, pas sa justification.
 */
describe('Contrat — portier d’ACK vs `verifySlackSignature`', () => {
  interface Cas {
    nom: string;
    body: string;
    timestamp: string;
    signature: string | 'AUTO';
    secret: string | undefined;
  }

  const T = nowSeconds();
  const CORPS = '{"type":"event_callback","event":{"type":"message","text":"salut"}}';

  const cas: Cas[] = [
    {
      nom: 'signature valide, horodatage frais',
      body: CORPS,
      timestamp: String(T),
      signature: 'AUTO',
      secret: SECRET,
    },
    { nom: 'corps vide, signé', body: '', timestamp: String(T), signature: 'AUTO', secret: SECRET },
    {
      nom: 'corps UTF-8 (accents, emoji) — le HMAC porte sur des OCTETS',
      body: '{"text":"héhé 🎉 où ça ?"}',
      timestamp: String(T),
      signature: 'AUTO',
      secret: SECRET,
    },
    {
      nom: 'corps portant une séquence échappée',
      body: '{"text":"a\\u0000b"}',
      timestamp: String(T),
      signature: 'AUTO',
      secret: SECRET,
    },
    {
      nom: 'corps de formulaire (interaction Slack, pas du JSON)',
      body: 'payload=%7B%22type%22%3A%22block_actions%22%7D',
      timestamp: String(T),
      signature: 'AUTO',
      secret: SECRET,
    },
    {
      nom: 'signature erronée mais de bonne longueur',
      body: CORPS,
      timestamp: String(T),
      signature: 'v0=' + 'f'.repeat(64),
      secret: SECRET,
    },
    {
      nom: 'signature trop courte',
      body: CORPS,
      timestamp: String(T),
      signature: 'v0=deadbeef',
      secret: SECRET,
    },
    { nom: 'signature vide', body: CORPS, timestamp: String(T), signature: '', secret: SECRET },
    {
      nom: 'signature sans préfixe v0=',
      body: CORPS,
      timestamp: String(T),
      signature: signWith(SECRET, String(T), CORPS).slice(3),
      secret: SECRET,
    },
    {
      nom: 'secret absent côté serveur',
      body: CORPS,
      timestamp: String(T),
      signature: 'AUTO',
      secret: undefined,
    },
    {
      nom: 'signature produite avec un AUTRE secret',
      body: CORPS,
      timestamp: String(T),
      signature: signWith('autre-secret', String(T), CORPS),
      secret: SECRET,
    },
    {
      nom: 'bord passé accepté (−280 s)',
      body: CORPS,
      timestamp: String(T - 280),
      signature: 'AUTO',
      secret: SECRET,
    },
    {
      nom: 'bord passé refusé (−320 s)',
      body: CORPS,
      timestamp: String(T - 320),
      signature: 'AUTO',
      secret: SECRET,
    },
    {
      nom: 'bord futur accepté (+280 s)',
      body: CORPS,
      timestamp: String(T + 280),
      signature: 'AUTO',
      secret: SECRET,
    },
    {
      nom: 'bord futur refusé (+320 s)',
      body: CORPS,
      timestamp: String(T + 320),
      signature: 'AUTO',
      secret: SECRET,
    },
    {
      nom: 'rejeu vieux d’un jour',
      body: CORPS,
      timestamp: String(T - 86_400),
      signature: 'AUTO',
      secret: SECRET,
    },
    {
      nom: 'horodatage non numérique',
      body: CORPS,
      timestamp: 'bonjour',
      signature: 'AUTO',
      secret: SECRET,
    },
    {
      nom: 'horodatage vide',
      body: CORPS,
      timestamp: '',
      signature: 'v0=' + 'a'.repeat(64),
      secret: SECRET,
    },
    {
      nom: 'horodatage négatif',
      body: CORPS,
      timestamp: '-1000',
      signature: 'AUTO',
      secret: SECRET,
    },
    {
      nom: 'horodatage en notation exponentielle',
      body: CORPS,
      timestamp: '1.7e9',
      signature: 'AUTO',
      secret: SECRET,
    },
    {
      nom: 'horodatage hexadécimal',
      body: CORPS,
      timestamp: '0x68a5',
      signature: 'AUTO',
      secret: SECRET,
    },
    {
      // `verifySlackSignature` TRIME avant d'appliquer sa regex, et le portier s'en remet à
      // `Number()`, qui trime aussi : les deux ACCEPTENT. Vérifié, pas supposé — c'était le
      // premier candidat à la divergence de cette revue, et il n'en est pas un.
      nom: 'horodatage entouré d’espaces',
      body: CORPS,
      timestamp: ` ${T} `,
      signature: 'AUTO',
      secret: SECRET,
    },
    {
      nom: 'horodatage à zéros de tête',
      body: CORPS,
      timestamp: `00${T}`,
      signature: 'AUTO',
      secret: SECRET,
    },
  ];

  it.each(cas)(
    '$nom — même verdict des deux côtés',
    async ({ body, timestamp, signature, secret }) => {
      const sig = signature === 'AUTO' ? signWith(secret ?? SECRET, timestamp, body) : signature;

      const portier = await callGatekeeper({ body, timestamp, signature: sig, secret });
      const reference = verifySlackSignature({
        signingSecret: secret,
        timestamp,
        signature: sig,
        rawBody: body,
      });

      expect(portier.statusCode === 200).toBe(reference.valid);
    },
  );

  it('les deux calculent le MÊME condensé pour un même triplet', async () => {
    // Le portier ne l'expose pas ; on le lit dans ce qu'il accepte. `computeSlackSignature` est
    // la référence, et si les deux base-strings divergeaient (`v0:` oublié, séparateur autre),
    // ce test tomberait avant tous les autres.
    const timestamp = String(nowSeconds());
    const attendu = computeSlackSignature(SECRET, timestamp, CORPS);

    const response = await callGatekeeper({ body: CORPS, timestamp, signature: attendu });
    expect(response.statusCode).toBe(200);
  });

  /**
   * ⚠️ DIVERGENCE RÉELLE, TROUVÉE PAR CE LOT — et volontairement FIGÉE ici plutôt que corrigée.
   *
   * `verifySlackSignature` exige `/^-?\d+$/` sur l'horodatage trimé ; le portier se contente de
   * `Number(timestamp)`, qui tolère en plus un `+` de tête et une partie DÉCIMALE. Un horodatage
   * `'+1755000000'` ou `'1755000000.5'` est donc ACCEPTÉ par le portier et REFUSÉ par la route
   * applicative.
   *
   * ⚠️ L'espace autour, lui, N'EST PAS une divergence — c'était l'hypothèse de départ de cette
   * revue, et elle est fausse : la regex est appliquée après `.trim()`. Le cas figure plus haut,
   * parmi les cas d'ACCORD.
   *
   * Pourquoi ce n'est pas une faille : produire une signature valide exige déjà le secret. Le
   * seul effet atteignable est un 200 rendu à Slack suivi d'un abandon silencieux côté
   * applicatif — et Slack n'émet jamais d'horodatage ainsi formé. Ce test existe pour que la
   * divergence soit CONNUE et cesse d'être une découverte : si l'une des deux copies change de
   * politique, c'est ici que ça rougit.
   */
  it.each(['+§', '§.0', '§.75'])(
    'DIVERGENCE CONNUE, horodatage de forme %j : le portier tolère, la route applicative refuse',
    async (forme) => {
      const timestamp = forme.replace('§', String(nowSeconds()));
      const signature = signWith(SECRET, timestamp, CORPS);

      const portier = await callGatekeeper({ body: CORPS, timestamp, signature });
      const reference = verifySlackSignature({
        signingSecret: SECRET,
        timestamp,
        signature,
        rawBody: CORPS,
      });

      expect(portier.statusCode).toBe(200);
      expect(reference.valid).toBe(false);
      expect(reference).toMatchObject({ reason: 'invalid_timestamp' });
    },
  );

  /**
   * ⚠️ SECONDE DIVERGENCE, dans l'AUTRE SENS — et c'est elle qui a rendu ce fichier
   * intermittent avant d'être comprise.
   *
   * Le portier PLANCHE l'instant courant (`Math.floor(Date.now() / 1000)`) avant de soustraire ;
   * `verifySlackSignature` divise sans plancher (`nowMs / 1000`). À exactement 300 s d'écart, la
   * fraction de seconde suffit donc à faire pencher les deux verdicts de côtés opposés : le
   * portier voit 300, la route applicative voit 300,4.
   *
   * Aucune conséquence de sécurité — la fenêtre reste de 300 s des deux côtés, à une seconde
   * près. Mais un test de bord écrit naïvement à ±299 s devient FLOTTANT dès que la machine
   * travaille, et un test qui rougit une fois sur cinq sans désigner sa cause finit par être
   * ignoré. Les cas d'accord ci-dessus sont donc placés à ±280 / ±320 s, hors de cette zone.
   */
  it('DIVERGENCE CONNUE : le portier PLANCHE l’instant courant, la route applicative non', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Un instant dont la partie fractionnaire est franche : 400 ms.
      vi.setSystemTime(new Date(1_755_000_000_400));
      const timestamp = String(1_755_000_000 - 300);
      const signature = signWith(SECRET, timestamp, CORPS);

      const portier = await callGatekeeper({ body: CORPS, timestamp, signature });
      const reference = verifySlackSignature({
        signingSecret: SECRET,
        timestamp,
        signature,
        rawBody: CORPS,
      });

      expect(portier.statusCode).toBe(200);
      expect(reference).toMatchObject({ valid: false, reason: 'stale_timestamp' });
    } finally {
      vi.useRealTimers();
    }
  });
});
