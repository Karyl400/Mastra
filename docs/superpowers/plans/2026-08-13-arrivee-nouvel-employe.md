# Parcours d'arrivée d'un nouvel employé — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quand une personne rejoint le workspace Slack, le système la connaît immédiatement, lui envoie un DM de bienvenue, l'invite dans une liste définie de canaux publics, et ne lui demande que son **poste**.

**Architecture:** Le point d'entrée reste `handleTeamJoin` (aucun LLM, zéro token). Il gagne trois gestes : écrire l'arrivant dans `slack_directory`, déclencher un service d'invitation aux canaux à responsabilité unique, et transporter la date d'arrivée jusqu'à la modale. La modale perd ses deux champs devinables (département, date de début) ; `employees.department` devient nullable.

**Tech Stack:** TypeScript strict, Mastra 1.57, Drizzle 0.45 / LibSQL, Zod 3.25.76 (épinglé), Vitest 4.1.

## Global Constraints

- `domain/` n'importe AUCUN framework — TypeScript pur. Verrouillé par `tests/unit/quality/architecture.test.ts`.
- Une feature ne dépend jamais d'une autre en `application/` : le croisement ne se fait qu'en `infrastructure/`, via un port déclaré par le consommateur (précédent : `MemberSource`, `ChannelAccessSource`).
- Zod épinglé `3.25.76` : pas de `z.discriminatedUnion`, pas de `\p{L}` dans un schéma de tool.
- Après **chaque** tâche : `npm run typecheck && npm run test:unit`.
- Toute factory reçoit ses dépendances par injection ; aucune instanciation au niveau module dans `features/`.
- **Ordre imposé** : la DDL de la tâche 5 est appliquée sur la Turso de production AVANT le déploiement du code de la tâche 6.
- Aucun échec d'invitation ne doit empêcher le DM de bienvenue de partir.

---

### Task 1: Lecture de `ONBOARDING_WELCOME_CHANNELS`

**Files:**
- Create: `src/features/directory/domain/services/welcome-channel-names.ts`
- Test: `tests/unit/directory/welcome-channel-names.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: `parseWelcomeChannelNames(raw: string | undefined | null): readonly string[]`

- [ ] **Step 1: Écrire le test rouge**

```ts
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
    expect(parseWelcomeChannelNames('')).toEqual([]);
    expect(parseWelcomeChannelNames('  , , ')).toEqual([]);
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npx vitest run tests/unit/directory/welcome-channel-names.test.ts`
Expected: FAIL — `Failed to resolve import`.

- [ ] **Step 3: Implémenter**

```ts
/**
 * Noms de canaux d'accueil, lus d'une variable d'environnement.
 *
 * Des NOMS et non des identifiants `C…` : c'est ce qu'un humain sait écrire et relire dans
 * un fichier de configuration. La résolution nom → identifiant est faite en `application`,
 * contre ce que Slack affirme au moment de l'invitation.
 *
 * ⚠️ TypeScript pur — aucun import.
 */
export function parseWelcomeChannelNames(raw: string | undefined | null): readonly string[] {
  const seen = new Set<string>();

  for (const part of (raw ?? '').split(',')) {
    // Le `#` de tête est retiré : c'est la forme sous laquelle Slack AFFICHE un canal, donc
    // celle qu'un humain recopiera. L'API, elle, ne connaît que le nom nu.
    const name = part.trim().replace(/^#+/, '').trim().toLowerCase();
    if (name) seen.add(name);
  }

  return Array.from(seen);
}
```

- [ ] **Step 4: Vérifier le vert**

Run: `npx vitest run tests/unit/directory/welcome-channel-names.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/features/directory/domain/services/welcome-channel-names.ts tests/unit/directory/welcome-channel-names.test.ts
git commit -m "feat(directory): lecture des noms de canaux d'accueil"
```

---

### Task 2: Service d'invitation aux canaux d'accueil

**Files:**
- Create: `src/features/directory/application/services/welcome-channels.service.ts`
- Test: `tests/unit/directory/welcome-channels.service.test.ts`

**Interfaces:**
- Consumes: `parseWelcomeChannelNames` (tâche 1) — appelé par l'appelant, pas par le service.
- Produces:
  - `type ChannelInviteStatus = 'invited' | 'already_in_channel' | 'bot_not_in_channel' | 'channel_not_found' | 'missing_scope' | 'failed'`
  - `interface ChannelInviteResult { readonly status: ChannelInviteStatus; readonly error?: string }`
  - `interface WelcomeChannelRef { readonly id: string; readonly name: string }`
  - `interface WelcomeChannelSource { listChannels(): Promise<readonly WelcomeChannelRef[]>; invite(channelId: string, slackUserId: string): Promise<ChannelInviteResult>; join(channelId: string): Promise<ChannelInviteResult> }`
  - `interface WelcomeChannelsReport { readonly outcome: 'completed' | 'degraded' | 'not_configured'; readonly joinedNames: readonly string[]; readonly failures: readonly { name: string; status: ChannelInviteStatus; error?: string }[] }`
  - `function makeWelcomeChannels(deps: { source: WelcomeChannelSource; channelNames: readonly string[] }): { run(slackUserId: string): Promise<WelcomeChannelsReport> }`

- [ ] **Step 1: Écrire le test rouge**

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  makeWelcomeChannels,
  type ChannelInviteResult,
  type WelcomeChannelSource,
} from '../../../src/features/directory/application/services/welcome-channels.service';

const CHANNELS = [
  { id: 'C_HQ', name: 'kisso-hq' },
  { id: 'C_RANDOM', name: 'random' },
];

function makeSource(overrides: Partial<WelcomeChannelSource> = {}): WelcomeChannelSource {
  return {
    listChannels: vi.fn(async () => CHANNELS),
    invite: vi.fn(async (): Promise<ChannelInviteResult> => ({ status: 'invited' })),
    join: vi.fn(async (): Promise<ChannelInviteResult> => ({ status: 'invited' })),
    ...overrides,
  };
}

describe('makeWelcomeChannels', () => {
  it('invite dans chacun des canaux configurés', async () => {
    const source = makeSource();
    const report = await makeWelcomeChannels({
      source,
      channelNames: ['kisso-hq', 'random'],
    }).run('U_NEW');

    expect(report.outcome).toBe('completed');
    expect(report.joinedNames).toEqual(['kisso-hq', 'random']);
    expect(source.invite).toHaveBeenCalledWith('C_HQ', 'U_NEW');
    expect(source.invite).toHaveBeenCalledWith('C_RANDOM', 'U_NEW');
  });

  it("compte `already_in_channel` comme un SUCCÈS — l'objectif est atteint", async () => {
    const source = makeSource({
      invite: vi.fn(async () => ({ status: 'already_in_channel' as const })),
    });
    const report = await makeWelcomeChannels({ source, channelNames: ['random'] }).run('U_NEW');

    expect(report.outcome).toBe('completed');
    expect(report.joinedNames).toEqual(['random']);
    expect(report.failures).toEqual([]);
  });

  it('rejoint le canal puis réessaie quand le bot n\'en est pas membre', async () => {
    const invite = vi
      .fn<[string, string], Promise<ChannelInviteResult>>()
      .mockResolvedValueOnce({ status: 'bot_not_in_channel' })
      .mockResolvedValueOnce({ status: 'invited' });
    const join = vi.fn(async () => ({ status: 'invited' as const }));
    const source = makeSource({ invite, join });

    const report = await makeWelcomeChannels({ source, channelNames: ['random'] }).run('U_NEW');

    expect(join).toHaveBeenCalledWith('C_RANDOM');
    expect(invite).toHaveBeenCalledTimes(2);
    expect(report.joinedNames).toEqual(['random']);
  });

  it("n'essaie jamais deux fois de rejoindre : un échec de join reste un échec", async () => {
    const invite = vi.fn(async () => ({ status: 'bot_not_in_channel' as const }));
    const join = vi.fn(async () => ({ status: 'failed' as const, error: 'boom' }));
    const source = makeSource({ invite, join });

    const report = await makeWelcomeChannels({ source, channelNames: ['random'] }).run('U_NEW');

    expect(invite).toHaveBeenCalledTimes(1);
    expect(report.outcome).toBe('degraded');
    expect(report.failures).toEqual([
      { name: 'random', status: 'bot_not_in_channel', error: 'boom' },
    ]);
  });

  it("un canal introuvable n'empêche pas les autres d'aboutir", async () => {
    const source = makeSource();
    const report = await makeWelcomeChannels({
      source,
      channelNames: ['inconnu', 'random'],
    }).run('U_NEW');

    expect(report.joinedNames).toEqual(['random']);
    expect(report.failures).toEqual([{ name: 'inconnu', status: 'channel_not_found' }]);
    expect(report.outcome).toBe('degraded');
  });

  it('ne fait AUCUN appel Slack quand aucun canal n\'est configuré', async () => {
    const source = makeSource();
    const report = await makeWelcomeChannels({ source, channelNames: [] }).run('U_NEW');

    expect(report.outcome).toBe('not_configured');
    expect(source.listChannels).not.toHaveBeenCalled();
    expect(source.invite).not.toHaveBeenCalled();
  });

  it('ne coule pas la boucle quand `listChannels` lève', async () => {
    const source = makeSource({
      listChannels: vi.fn(async () => {
        throw new Error('slack down');
      }),
    });
    const report = await makeWelcomeChannels({ source, channelNames: ['random'] }).run('U_NEW');

    expect(report.outcome).toBe('degraded');
    expect(report.joinedNames).toEqual([]);
    expect(report.failures[0]?.status).toBe('failed');
  });

  it('ne consomme plus un appel par canal après un `missing_scope`', async () => {
    const invite = vi.fn(async () => ({ status: 'missing_scope' as const }));
    const source = makeSource({ invite });

    const report = await makeWelcomeChannels({
      source,
      channelNames: ['kisso-hq', 'random'],
    }).run('U_NEW');

    expect(invite).toHaveBeenCalledTimes(1);
    expect(report.failures).toHaveLength(2);
    expect(report.outcome).toBe('degraded');
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npx vitest run tests/unit/directory/welcome-channels.service.test.ts`
Expected: FAIL — `Failed to resolve import`.

- [ ] **Step 3: Implémenter**

```ts
import { logger } from '../../../../shared/logger';

/**
 * INVITATION D'UN ARRIVANT dans les canaux publics d'accueil.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Pourquoi un service distinct de `ChannelCoverageService`
 * ────────────────────────────────────────────────────────────────────────────
 * La couverture règle l'appartenance du BOT (`conversations.join`, sur lui-même) ; celui-ci
 * règle l'appartenance d'un TIERS (`conversations.invite`, sur quelqu'un d'autre). Ce sont
 * deux droits différents, deux scopes différents et deux modes d'échec différents. Les fondre
 * donnerait un service dont on ne saurait plus dire, en lisant un rapport dégradé, qui n'a
 * pas pu entrer où.
 *
 * ⚠️ `already_in_channel` est un SUCCÈS. L'objectif est « l'arrivant est dans le canal », pas
 * « nous l'y avons mis ». Le compter comme une erreur rendrait dégradée toute réexécution —
 * même arbitrage que `alreadyMember` dans la couverture, et que « non applicable ≠ dégradé »
 * sur l'invitation Slack du workflow d'onboarding.
 *
 * ⚠️ Le service est *best-effort* de bout en bout et ne lève JAMAIS : son appelant est
 * `handleTeamJoin`, dont le DM de bienvenue ne doit dépendre d'aucun canal.
 */

export type ChannelInviteStatus =
  | 'invited'
  | 'already_in_channel'
  /** Le BOT n'est pas membre : il doit rejoindre avant de pouvoir inviter. */
  | 'bot_not_in_channel'
  | 'channel_not_found'
  /** Scope manquant — seule issue qui appelle un geste humain. */
  | 'missing_scope'
  | 'failed';

export interface ChannelInviteResult {
  readonly status: ChannelInviteStatus;
  readonly error?: string;
}

export interface WelcomeChannelRef {
  readonly id: string;
  readonly name: string;
}

/**
 * La source, déclarée par son CONSOMMATEUR — `application` ne connaît pas Slack.
 * L'adaptateur qui la relie à `SlackWorkspaceProvider` vit en `infrastructure`.
 */
export interface WelcomeChannelSource {
  /** Canaux du workspace, nom ET identifiant. La résolution se fait ici, pas en config. */
  listChannels(): Promise<readonly WelcomeChannelRef[]>;
  invite(channelId: string, slackUserId: string): Promise<ChannelInviteResult>;
  /** Le bot se rend membre du canal. Rendu sous le même vocabulaire, pour un seul `switch`. */
  join(channelId: string): Promise<ChannelInviteResult>;
}

export interface WelcomeChannelFailure {
  readonly name: string;
  readonly status: ChannelInviteStatus;
  readonly error?: string;
}

export interface WelcomeChannelsReport {
  /**
   * `not_configured` est DISTINCT de `completed` : « personne n'a demandé d'invitation »
   * ne se lit pas comme « toutes les invitations ont abouti ».
   */
  readonly outcome: 'completed' | 'degraded' | 'not_configured';
  /** Noms des canaux où l'arrivant se trouve à l'issue du passage — pour le DM. */
  readonly joinedNames: readonly string[];
  readonly failures: readonly WelcomeChannelFailure[];
}

export interface WelcomeChannelsDeps {
  readonly source: WelcomeChannelSource;
  readonly channelNames: readonly string[];
}

export interface WelcomeChannelsService {
  run(slackUserId: string): Promise<WelcomeChannelsReport>;
}

export function makeWelcomeChannels(deps: WelcomeChannelsDeps): WelcomeChannelsService {
  return {
    async run(slackUserId: string): Promise<WelcomeChannelsReport> {
      if (deps.channelNames.length === 0) {
        // `warn` et non `error` : ne rien configurer est un choix légitime. Mais le silence
        // total ferait ressembler l'absence de configuration à une panne d'invitation.
        logger.warn('No welcome channels configured — skipping newcomer invitations', {
          slackUserId,
        });
        return { outcome: 'not_configured', joinedNames: [], failures: [] };
      }

      let byName: Map<string, WelcomeChannelRef>;
      try {
        const channels = await deps.source.listChannels();
        byName = new Map(channels.map((c) => [c.name.toLowerCase(), c]));
      } catch (error) {
        // Sans annuaire de canaux, AUCUN nom n'est résoluble : on rend un échec par canal
        // demandé plutôt qu'un rapport vide, qui se lirait « rien à faire ».
        logger.error('Unable to list Slack channels for the welcome invitations', {
          error,
          slackUserId,
        });
        return {
          outcome: 'degraded',
          joinedNames: [],
          failures: deps.channelNames.map((name) => ({
            name,
            status: 'failed' as const,
            error: messageOf(error),
          })),
        };
      }

      const joinedNames: string[] = [];
      const failures: WelcomeChannelFailure[] = [];
      let missingScope = false;

      for (const name of deps.channelNames) {
        const channel = byName.get(name);
        if (!channel) {
          failures.push({ name, status: 'channel_not_found' });
          continue;
        }

        if (missingScope) {
          // La tentative suivante échouerait identiquement : on enregistre sans dépenser
          // un appel de plus. Même arbitrage que `ChannelCoverageService`.
          failures.push({ name, status: 'missing_scope' });
          continue;
        }

        // SÉQUENTIEL, jamais `Promise.all` : `conversations.invite` est plafonné par Slack,
        // et une salve simultanée se ferait rate-limiter — le remède produirait le symptôme.
        const outcome = await inviteOnce(deps.source, channel, slackUserId);

        if (outcome.status === 'invited' || outcome.status === 'already_in_channel') {
          joinedNames.push(name);
          continue;
        }
        if (outcome.status === 'missing_scope') missingScope = true;
        failures.push({ name, status: outcome.status, error: outcome.error });
      }

      const report: WelcomeChannelsReport = {
        outcome: failures.length > 0 ? 'degraded' : 'completed',
        joinedNames,
        failures,
      };

      logReport(report, slackUserId, missingScope);
      return report;
    },
  };
}

/**
 * Une invitation, avec UN seul rattrapage : si le bot n'est pas membre du canal, il le
 * rejoint et réessaie. Jamais deux fois — un `join` qui échoue est définitif pour ce
 * passage, et boucler consommerait du quota d'API pour répéter le même refus.
 */
async function inviteOnce(
  source: WelcomeChannelSource,
  channel: WelcomeChannelRef,
  slackUserId: string,
): Promise<ChannelInviteResult> {
  const first = await safely(() => source.invite(channel.id, slackUserId));
  if (first.status !== 'bot_not_in_channel') return first;

  const joined = await safely(() => source.join(channel.id));
  if (joined.status !== 'invited' && joined.status !== 'already_in_channel') {
    // On conserve le statut de l'INVITATION (`bot_not_in_channel`, la cause réelle) et
    // l'erreur du `join` (ce qui a empêché de la lever). Écraser le premier par le second
    // dirait « le bot n'a pas pu rejoindre » sans dire pourquoi on essayait.
    return { status: 'bot_not_in_channel', error: joined.error };
  }

  return safely(() => source.invite(channel.id, slackUserId));
}

/** Un port qui lève malgré son contrat ne doit pas couler la boucle. */
async function safely(call: () => Promise<ChannelInviteResult>): Promise<ChannelInviteResult> {
  try {
    return await call();
  } catch (error) {
    return { status: 'failed', error: messageOf(error) };
  }
}

function logReport(
  report: WelcomeChannelsReport,
  slackUserId: string,
  missingScope: boolean,
): void {
  if (missingScope) {
    logger.error(
      'Newcomer channel invitations blocked — a Slack scope is missing. Add `channels:manage` ' +
        'in OAuth & Permissions, THEN reinstall the app: adding the scope alone propagates nothing.',
      { slackUserId, failures: report.failures.length },
    );
    return;
  }

  if (report.outcome === 'degraded') {
    logger.error('Newcomer channel invitations degraded', {
      slackUserId,
      joined: report.joinedNames,
      failures: report.failures,
    });
    return;
  }

  logger.info('Newcomer invited to the welcome channels', {
    slackUserId,
    joined: report.joinedNames,
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

- [ ] **Step 4: Vérifier le vert**

Run: `npx vitest run tests/unit/directory/welcome-channels.service.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/features/directory/application/services/welcome-channels.service.ts tests/unit/directory/welcome-channels.service.test.ts
git commit -m "feat(directory): service d'invitation d'un arrivant aux canaux d'accueil"
```

---

### Task 3: Adaptateur Slack du service d'invitation

**Files:**
- Create: `src/features/directory/infrastructure/providers/slack-welcome-channel.adapter.ts`
- Test: `tests/unit/directory/slack-welcome-channel.adapter.test.ts`

**Interfaces:**
- Consumes: `WelcomeChannelSource`, `ChannelInviteResult`, `WelcomeChannelRef` (tâche 2).
- Produces:
  - `interface SlackInviteClient { listChannels(): Promise<readonly { id: string; name: string }[]>; inviteToChannel(channelId: string, userId: string): Promise<void>; joinChannel(channelId: string): Promise<unknown> }`
  - `class SlackWelcomeChannelSource implements WelcomeChannelSource { constructor(slack: SlackInviteClient) }`

- [ ] **Step 1: Écrire le test rouge**

```ts
import { describe, expect, it, vi } from 'vitest';
import { SlackWelcomeChannelSource } from '../../../src/features/directory/infrastructure/providers/slack-welcome-channel.adapter';

function clientWith(inviteError: unknown) {
  return {
    listChannels: vi.fn(async () => [{ id: 'C1', name: 'random' }]),
    inviteToChannel: vi.fn(async () => {
      throw inviteError;
    }),
    joinChannel: vi.fn(async () => ({ ok: true })),
  };
}

describe('SlackWelcomeChannelSource', () => {
  it('traduit un succès', async () => {
    const client = {
      listChannels: vi.fn(async () => [{ id: 'C1', name: 'random' }]),
      inviteToChannel: vi.fn(async () => undefined),
      joinChannel: vi.fn(async () => ({ ok: true })),
    };
    const source = new SlackWelcomeChannelSource(client);
    expect(await source.invite('C1', 'U1')).toEqual({ status: 'invited' });
  });

  it('traduit `already_in_channel`', async () => {
    const source = new SlackWelcomeChannelSource(
      clientWith(Object.assign(new Error('x'), { data: { error: 'already_in_channel' } })),
    );
    expect((await source.invite('C1', 'U1')).status).toBe('already_in_channel');
  });

  it('traduit `not_in_channel` en `bot_not_in_channel`', async () => {
    const source = new SlackWelcomeChannelSource(
      clientWith(Object.assign(new Error('x'), { data: { error: 'not_in_channel' } })),
    );
    expect((await source.invite('C1', 'U1')).status).toBe('bot_not_in_channel');
  });

  it('traduit `channel_not_found`', async () => {
    const source = new SlackWelcomeChannelSource(
      clientWith(Object.assign(new Error('x'), { data: { error: 'channel_not_found' } })),
    );
    expect((await source.invite('C1', 'U1')).status).toBe('channel_not_found');
  });

  it('traduit `missing_scope`', async () => {
    const source = new SlackWelcomeChannelSource(
      clientWith(Object.assign(new Error('x'), { data: { error: 'missing_scope' } })),
    );
    expect((await source.invite('C1', 'U1')).status).toBe('missing_scope');
  });

  it("lit aussi le code d'erreur dans le MESSAGE, faute de champ `data`", async () => {
    const source = new SlackWelcomeChannelSource(
      clientWith(new Error('An API error occurred: already_in_channel')),
    );
    expect((await source.invite('C1', 'U1')).status).toBe('already_in_channel');
  });

  it('rend `failed` avec le message pour tout code inconnu', async () => {
    const source = new SlackWelcomeChannelSource(clientWith(new Error('boom')));
    expect(await source.invite('C1', 'U1')).toEqual({ status: 'failed', error: 'boom' });
  });

  it('traduit un `join` réussi en `invited`', async () => {
    const client = {
      listChannels: vi.fn(async () => []),
      inviteToChannel: vi.fn(async () => undefined),
      joinChannel: vi.fn(async () => ({ ok: true })),
    };
    expect((await new SlackWelcomeChannelSource(client).join('C1')).status).toBe('invited');
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npx vitest run tests/unit/directory/slack-welcome-channel.adapter.test.ts`
Expected: FAIL — `Failed to resolve import`.

- [ ] **Step 3: Implémenter**

```ts
import type {
  ChannelInviteResult,
  ChannelInviteStatus,
  WelcomeChannelRef,
  WelcomeChannelSource,
} from '../../application/services/welcome-channels.service';

/**
 * Le pont entre `WelcomeChannelsService` (qui ne connaît pas Slack) et le fournisseur Slack.
 * Rien d'autre : pas une décision, pas une politique.
 *
 * Il vit en `infrastructure` pour la même raison que `SlackChannelAccess` et `SlackMemberSource` —
 * c'est la seule couche où deux features peuvent se croiser.
 */

/**
 * Le strict nécessaire côté Slack. On ne dépend PAS de `SlackWorkspaceProvider` entier : ses
 * sept méthodes n'ont ici aucun usage, et une dépendance large obligerait toute doublure de
 * test à simuler une API dont ce composant n'a que faire.
 */
export interface SlackInviteClient {
  listChannels(): Promise<readonly { id: string; name: string }[]>;
  inviteToChannel(channelId: string, userId: string): Promise<void>;
  joinChannel(channelId: string): Promise<unknown>;
}

/**
 * Codes d'erreur Slack traduits en états NOMMÉS.
 *
 * Liste FERMÉE : tout code absent devient `failed` avec son message conservé. Une traduction
 * par défaut optimiste ferait passer un refus inconnu pour un succès — exactement le mode
 * d'échec de `status = Sent` posé avant le `try`.
 */
const STATUS_BY_SLACK_ERROR: ReadonlyMap<string, ChannelInviteStatus> = new Map([
  ['already_in_channel', 'already_in_channel'],
  // Slack rend `cant_invite_self` quand la cible est le bot lui-même : le résultat visé
  // (« la personne est dans le canal ») est atteint, donc ce n'est pas un échec.
  ['cant_invite_self', 'already_in_channel'],
  ['not_in_channel', 'bot_not_in_channel'],
  ['channel_not_found', 'channel_not_found'],
  ['missing_scope', 'missing_scope'],
  ['not_allowed_token_type', 'missing_scope'],
]);

export class SlackWelcomeChannelSource implements WelcomeChannelSource {
  constructor(private readonly slack: SlackInviteClient) {}

  async listChannels(): Promise<readonly WelcomeChannelRef[]> {
    const channels = await this.slack.listChannels();
    return channels.map((c) => ({ id: c.id, name: c.name }));
  }

  async invite(channelId: string, slackUserId: string): Promise<ChannelInviteResult> {
    try {
      await this.slack.inviteToChannel(channelId, slackUserId);
      return { status: 'invited' };
    } catch (error) {
      return classify(error);
    }
  }

  async join(channelId: string): Promise<ChannelInviteResult> {
    try {
      await this.slack.joinChannel(channelId);
      return { status: 'invited' };
    } catch (error) {
      return classify(error);
    }
  }
}

/**
 * Le code d'erreur Slack, lu d'abord dans `error.data.error` (forme du SDK), puis dans le
 * message.
 *
 * La seconde lecture n'est pas un luxe : `SlackAdapter` réemballe certaines erreurs en
 * `Error` de prose, et le champ `data` disparaît alors. Sans elle, un `already_in_channel`
 * réemballé compterait pour un échec et rendrait dégradée toute réexécution.
 */
function classify(error: unknown): ChannelInviteResult {
  const message = error instanceof Error ? error.message : String(error);
  const fromData = (error as { data?: { error?: unknown } } | null)?.data?.error;
  const code = typeof fromData === 'string' ? fromData : undefined;

  if (code) {
    const status = STATUS_BY_SLACK_ERROR.get(code);
    if (status) return { status, error: message };
  }

  for (const [slackError, status] of STATUS_BY_SLACK_ERROR) {
    if (message.includes(slackError)) return { status, error: message };
  }

  return { status: 'failed', error: message };
}
```

- [ ] **Step 4: Vérifier le vert**

Run: `npx vitest run tests/unit/directory/slack-welcome-channel.adapter.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/features/directory/infrastructure/providers/slack-welcome-channel.adapter.ts tests/unit/directory/slack-welcome-channel.adapter.test.ts
git commit -m "feat(directory): adaptateur Slack des invitations d'accueil"
```

---

### Task 4: `handleTeamJoin` — annuaire, canaux, date d'arrivée

**Files:**
- Modify: `src/features/notification/infrastructure/handlers/slack-events.handler.ts` (`SlackEventsHandlerOptions`, `buildWelcomeBlocks`, `handleTeamJoin`)
- Modify: `src/features/notification/infrastructure/handlers/profile-modal.ts` (`ProfileModalPrefill`, `encodePrefill`, `decodePrefill`)
- Test: `tests/unit/handlers/team-join.test.ts`

**Interfaces:**
- Consumes: `WelcomeChannelsService` (tâche 2), `DirectoryRepository.upsertFacts`.
- Produces:
  - `ProfileModalPrefill` gagne `joinedAt?: string | null` (ISO 8601).
  - `SlackEventsHandlerOptions` gagne `welcomeChannels?: WelcomeChannelsService | null` et `directoryRepository` (déjà présent sous le nom `directory`).

- [ ] **Step 1: Écrire le test rouge**

```ts
import { describe, expect, it, vi } from 'vitest';
import { SlackEventsHandler } from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { decodePrefill } from '../../../src/features/notification/infrastructure/handlers/profile-modal';

function makeHandler(overrides: Record<string, unknown> = {}) {
  const sendBlocks = vi.fn(async () => undefined);
  const upsertFacts = vi.fn(async () => undefined);
  const run = vi.fn(async () => ({
    outcome: 'completed' as const,
    joinedNames: ['kisso-hq', 'random'],
    failures: [],
  }));

  const handler = new SlackEventsHandler({
    chatProvider: { sendBlocks },
    workspaceProvider: {
      getUserById: vi.fn(async () => ({
        id: 'U_NEW',
        email: 'lea@kisso.com',
        firstName: 'Léa',
        lastName: 'Bamba',
        teamId: 'T1',
      })),
    },
    directory: { upsertFacts, findBySlackUserId: vi.fn(async () => null) },
    welcomeChannels: { run },
    conversationRepository: null,
    dedupRepository: null,
    rateLimiter: null,
    ...overrides,
  } as never);

  return { handler, sendBlocks, upsertFacts, run };
}

const EVENT = {
  type: 'team_join' as const,
  user: { id: 'U_NEW', profile: { first_name: 'Léa', last_name: 'Bamba', email: 'lea@kisso.com' } },
};

describe('handleTeamJoin', () => {
  it("écrit l'arrivant dans l'annuaire dès la seconde zéro", async () => {
    const { handler, upsertFacts } = makeHandler();
    await handler.handleTeamJoin(EVENT as never);

    expect(upsertFacts).toHaveBeenCalledTimes(1);
    const [facts] = upsertFacts.mock.calls[0] as [{ slackUserId: string; email: string | null }];
    expect(facts.slackUserId).toBe('U_NEW');
    expect(facts.email).toBe('lea@kisso.com');
  });

  it('invite dans les canaux d\'accueil', async () => {
    const { handler, run } = makeHandler();
    await handler.handleTeamJoin(EVENT as never);
    expect(run).toHaveBeenCalledWith('U_NEW');
  });

  it("transporte la date d'arrivée dans le bouton de la modale", async () => {
    const { handler, sendBlocks } = makeHandler();
    await handler.handleTeamJoin(EVENT as never);

    const blocks = sendBlocks.mock.calls[0]?.[2] as { elements?: { value?: string }[] }[];
    const button = blocks.flatMap((b) => b.elements ?? []).find((e) => e.value);
    const prefill = decodePrefill(button?.value, '');
    expect(prefill.joinedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("le DM part MÊME si l'invitation aux canaux échoue entièrement", async () => {
    const { handler, sendBlocks } = makeHandler({
      welcomeChannels: {
        run: vi.fn(async () => {
          throw new Error('slack down');
        }),
      },
    });

    await handler.handleTeamJoin(EVENT as never);
    expect(sendBlocks).toHaveBeenCalledTimes(1);
  });

  it("le DM part MÊME si l'écriture dans l'annuaire échoue", async () => {
    const { handler, sendBlocks } = makeHandler({
      directory: {
        upsertFacts: vi.fn(async () => {
          throw new Error('turso down');
        }),
        findBySlackUserId: vi.fn(async () => null),
      },
    });

    await handler.handleTeamJoin(EVENT as never);
    expect(sendBlocks).toHaveBeenCalledTimes(1);
  });

  it('cite les canaux rejoints dans le message de bienvenue', async () => {
    const { handler, sendBlocks } = makeHandler();
    await handler.handleTeamJoin(EVENT as never);

    const blocks = JSON.stringify(sendBlocks.mock.calls[0]?.[2]);
    expect(blocks).toContain('#kisso-hq');
    expect(blocks).toContain('#random');
  });

  it('ne cite aucun canal quand aucun n\'a abouti', async () => {
    const { handler, sendBlocks } = makeHandler({
      welcomeChannels: {
        run: vi.fn(async () => ({ outcome: 'not_configured', joinedNames: [], failures: [] })),
      },
    });

    await handler.handleTeamJoin(EVENT as never);
    expect(JSON.stringify(sendBlocks.mock.calls[0]?.[2])).not.toContain('#');
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npx vitest run tests/unit/handlers/team-join.test.ts`
Expected: FAIL — `upsertFacts` non appelé, `joinedAt` absent.

- [ ] **Step 3: Implémenter — `profile-modal.ts`**

Ajouter `joinedAt` à `ProfileModalPrefill`, `encodePrefill` et `decodePrefill` :

```ts
export interface ProfileModalPrefill {
  slackUserId: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  /**
   * Instant du `team_join`, en ISO 8601 — la date d'arrivée RÉELLE.
   *
   * Ce n'est pas une valeur de remplissage : c'est le fait que Slack vient d'annoncer, et
   * c'est précisément pour cela que le sélecteur de date a pu disparaître de la modale.
   * Absent sur un bouton émis avant ce lot : l'appelant retombe alors sur l'instant courant.
   */
  joinedAt?: string | null;
}

export function encodePrefill(prefill: ProfileModalPrefill): string {
  return JSON.stringify({
    u: prefill.slackUserId,
    e: prefill.email ?? undefined,
    f: prefill.firstName ?? undefined,
    l: prefill.lastName ?? undefined,
    j: prefill.joinedAt ?? undefined,
  });
}
```

Et dans `decodePrefill`, sur le chemin JSON :

```ts
    const parsed = JSON.parse(value) as {
      u?: string;
      e?: string;
      f?: string;
      l?: string;
      j?: string;
    };
    return {
      slackUserId: parsed.u || fallbackUserId,
      email: parsed.e ?? null,
      firstName: parsed.f ?? null,
      lastName: parsed.l ?? null,
      joinedAt: parsed.j ?? null,
    };
```

- [ ] **Step 4: Implémenter — `slack-events.handler.ts`**

Importer le type du service et l'ajouter aux options :

```ts
import type { WelcomeChannelsService } from '../../../directory/application/services/welcome-channels.service';
```

```ts
  /**
   * Invitation de l'arrivant aux canaux publics d'accueil.
   *
   * `null` la DÉSACTIVE — c'est le comportement d'avant ce lot, et celui de tout test qui
   * ne s'intéresse pas aux canaux.
   */
  welcomeChannels?: WelcomeChannelsService | null;
```

`buildWelcomeBlocks` prend un second argument :

```ts
/**
 * Ligne citant les canaux rejoints. Vide quand il n'y en a aucun — annoncer « tu as été
 * ajouté à » suivi de rien serait pire que le silence.
 */
function channelsLine(joinedNames: readonly string[]): string {
  if (joinedNames.length === 0) return '';
  const list = joinedNames.map((name) => `#${name}`).join(', ');
  return `\n\nJe t'ai ajouté à ${list} — tu y trouveras l'équipe.`;
}

function buildWelcomeBlocks(
  prefill: ProfileModalPrefill,
  joinedNames: readonly string[] = [],
): SlackBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `${greet(prefill.firstName ?? '')}\n\n` +
          "Ravi de t'accueillir chez Kisso. Il me manque une information " +
          'pour préparer ton intégration — une minute suffit.' +
          channelsLine(joinedNames),
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: COMPLETE_PROFILE_ACTION_ID,
          style: 'primary',
          text: { type: 'plain_text', text: 'Compléter mon profil' },
          value: encodePrefill(prefill),
        },
      ],
    },
  ];
}
```

`handleTeamJoin` :

```ts
  async handleTeamJoin(event: SlackTeamJoinEvent): Promise<void> {
    const user = event.user;
    if (!user?.id) {
      logger.warn('team_join without a user id, skipping');
      return;
    }

    // L'instant de l'événement EST la date d'arrivée. Lu une seule fois, avant toute E/S :
    // deux lectures d'horloge donneraient deux dates pour un seul fait.
    const joinedAt = new Date().toISOString();

    try {
      const identity = await this.resolveNewcomer(user);
      logger.info('Welcoming a newcomer', {
        userId: user.id,
        hasEmail: Boolean(identity.email),
      });

      // Les deux gestes qui précèdent le DM sont indépendants l'un de l'autre ET du DM.
      // Chacun avale son échec : ni l'annuaire ni les canaux ne valent de priver quelqu'un
      // de son message de bienvenue.
      await this.recordNewcomer(user.id, identity, joinedAt);
      const joinedNames = await this.inviteToWelcomeChannels(user.id);

      await this.chatProvider.sendBlocks(
        user.id,
        greet(identity.firstName ?? ''),
        buildWelcomeBlocks({ ...identity, joinedAt }, joinedNames),
      );
    } catch (error) {
      logger.error('Unable to send the welcome DM', { error, userId: user.id });
    }
  }

  /**
   * Rend l'arrivant résolvable dès la seconde zéro.
   *
   * Sans cela, l'annuaire n'apprend une personne qu'au premier message qu'elle envoie — et
   * `findEmployeeByEmail`, qui s'y replie depuis le 2026-08-12, répondait « introuvable »
   * pour quelqu'un que Slack venait pourtant d'annoncer.
   */
  private async recordNewcomer(
    slackUserId: string,
    identity: ProfileModalPrefill,
    joinedAt: string,
  ): Promise<void> {
    if (!this.directory) return;

    try {
      await this.directory.upsertFacts(
        {
          slackUserId,
          teamId: '',
          email: identity.email ?? null,
          realName: [identity.firstName, identity.lastName].filter(Boolean).join(' '),
          displayName: identity.firstName ?? '',
          firstName: identity.firstName ?? null,
          lastName: identity.lastName ?? null,
          title: null,
          isBot: false,
          isAdmin: false,
          isRestricted: false,
          isUltraRestricted: false,
          isDeleted: false,
        },
        new Date(joinedAt),
      );
    } catch (error) {
      logger.error('Unable to record the newcomer in the directory', { error, slackUserId });
    }
  }

  /** Rend les noms des canaux où l'arrivant se trouve. Ne lève jamais. */
  private async inviteToWelcomeChannels(slackUserId: string): Promise<readonly string[]> {
    if (!this.welcomeChannels) return [];

    try {
      const report = await this.welcomeChannels.run(slackUserId);
      return report.joinedNames;
    } catch (error) {
      logger.error('Welcome channel invitations threw', { error, slackUserId });
      return [];
    }
  }
```

Déclarer le champ privé `welcomeChannels` dans la classe, alimenté depuis les options (`options.welcomeChannels ?? undefined`), sur le modèle exact du champ `directory` existant.

- [ ] **Step 5: Vérifier le vert**

Run: `npx vitest run tests/unit/handlers/team-join.test.ts && npm run typecheck`
Expected: PASS (7 tests), typecheck sans erreur.

- [ ] **Step 6: Commit**

```bash
git add src/features/notification/infrastructure/handlers/ tests/unit/handlers/team-join.test.ts
git commit -m "feat(onboarding): l'arrivant entre dans l'annuaire et dans les canaux d'accueil"
```

---

### Task 5: `employees.department` devient facultatif

**Files:**
- Create: `scripts/ddl-employees-department-nullable.sql`
- Modify: `src/infrastructure/database/schema.ts:31` et le bloc d'index
- Modify: `src/features/employee/domain/entities/employee.ts:8`
- Modify: `src/features/employee/application/dtos/employee.dto.ts:152`
- Modify: `src/features/employee/application/mappers/employee.mapper.ts:10,22`
- Modify: `src/features/employee/application/tools/get-employee-profile.ts:96`
- Modify: `src/features/document/domain/services/document-template.ts`
- Test: `tests/unit/employee/department-optional.test.ts`

**Interfaces:**
- Produces: `Employee.department: string | null`.

- [ ] **Step 1: Écrire la DDL**

```sql
-- Rend `employees.department` NULLABLE.
--
-- SQLite n'a pas d'ALTER COLUMN : la seule voie est la reconstruction de table.
-- Retenu contre une valeur sentinelle, qui finit toujours par être relue comme une vraie
-- valeur — mode d'échec récurrent de ce dépôt (`emailSent: false` sous `status: 'success'`,
-- `documents.content` perdu en silence, `status = Sent` posé avant le `try`).
--
-- ⚠️ ORDRE IMPOSÉ : appliquer CE FICHIER **avant** de déployer le code qui cesse de
-- renseigner la colonne. L'inverse échouerait sur la contrainte NOT NULL.
--
-- `idx_employees_department` n'est PAS recréé : une colonne qu'on ne renseigne plus n'a
-- aucune raison d'être indexée.
--
-- Rejouable : la table reconstruite porte déjà la colonne nullable, un second passage
-- recopie simplement les mêmes lignes.

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS employees_new (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  department TEXT,
  position TEXT NOT NULL,
  start_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  onboarding_status TEXT NOT NULL DEFAULT 'not_started',
  manager_id TEXT,
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  emergency_contact_relationship TEXT,
  salary_amount REAL,
  salary_currency TEXT DEFAULT 'EUR',
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  CONSTRAINT chk_employees_email CHECK (email LIKE '%@%')
);

INSERT INTO employees_new SELECT
  id, first_name, last_name, email, phone, department, position, start_date,
  status, onboarding_status, manager_id, emergency_contact_name,
  emergency_contact_phone, emergency_contact_relationship, salary_amount,
  salary_currency, metadata, created_at, updated_at, deleted_at
FROM employees;

DROP TABLE employees;
ALTER TABLE employees_new RENAME TO employees;

CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_email ON employees (email);
CREATE INDEX IF NOT EXISTS idx_employees_status ON employees (status);
CREATE INDEX IF NOT EXISTS idx_employees_manager ON employees (manager_id);
CREATE INDEX IF NOT EXISTS idx_employees_onboarding_status ON employees (onboarding_status);
CREATE INDEX IF NOT EXISTS idx_employees_start_date ON employees (start_date);
CREATE INDEX IF NOT EXISTS idx_employees_deleted_at ON employees (deleted_at);
CREATE INDEX IF NOT EXISTS idx_employees_name_search ON employees (first_name, last_name);

PRAGMA foreign_keys = ON;
```

- [ ] **Step 2: Écrire le test rouge**

```ts
import { describe, expect, it } from 'vitest';
import { createEmployee } from '../../../src/features/employee/domain/entities/employee';
import { buildDocumentOutline } from '../../../src/features/document/domain/services/document-template';

describe('department facultatif', () => {
  it('accepte un employé sans département', () => {
    const employee = createEmployee({
      id: 'e1',
      firstName: 'Léa',
      lastName: 'Bamba',
      email: 'lea@kisso.com',
      department: null,
      position: 'Software Engineer',
      startDate: '2026-08-13T00:00:00.000Z',
      managerId: null,
    });

    expect(employee.department).toBeNull();
  });

  it("n'imprime aucun département vide dans un document", () => {
    const outline = buildDocumentOutline({
      type: 'guide',
      title: 'Guide',
      content: 'Bonjour',
      employee: {
        firstName: 'Léa',
        lastName: 'Bamba',
        email: 'lea@kisso.com',
        department: null,
        position: 'Software Engineer',
      },
    } as never);

    expect(JSON.stringify(outline)).not.toContain('null');
  });
});
```

- [ ] **Step 3: Vérifier l'échec**

Run: `npx vitest run tests/unit/employee/department-optional.test.ts`
Expected: FAIL — `Type 'null' is not assignable to type 'string'` au typecheck, ou `null` imprimé.

- [ ] **Step 4: Implémenter**

`src/infrastructure/database/schema.ts` — retirer `.notNull()` sur `department` et supprimer `departmentIdx` du bloc d'index, avec le commentaire :

```ts
    /**
     * NULLABLE depuis le 2026-08-13 : le parcours d'arrivée ne demande plus le département.
     * `NULL` est le seul encodage honnête de « on a délibérément cessé de collecter ça » —
     * une sentinelle dans une colonne NOT NULL finit toujours par être relue comme une vraie
     * valeur. `idx_employees_department` est supprimé au passage.
     */
    department: text('department'),
```

`employee.ts` : `readonly department: string | null;`

`employee.dto.ts` : `department: departmentSchema.nullable()` sur le DTO de sortie.

`employee.mapper.ts` : recopier `department` tel quel des deux côtés (aucun `??` — un `''` de remplissage recréerait la sentinelle).

`get-employee-profile.ts:96` : `department: employee.department ?? undefined,` — le champ DISPARAÎT du tool-result plutôt que de valoir `null`, ce qui économise aussi quelques tokens.

`document-template.ts` : le bloc `fields` n'ajoute la ligne « Département » que si la valeur est non vide.

- [ ] **Step 5: Vérifier le vert**

Run: `npm run typecheck && npx vitest run tests/unit/employee/department-optional.test.ts`
Expected: PASS.

- [ ] **Step 6: Appliquer la DDL en production**

```bash
node --env-file=.env scripts/apply-ddl.mjs scripts/ddl-employees-department-nullable.sql
```

(Si ce script n'existe pas, exécuter les statements un à un via `@libsql/client`, comme pour `ddl-documents-content.sql`.)
Expected: reconstruction sans erreur, `SELECT COUNT(*) FROM employees` inchangé.

- [ ] **Step 7: Commit**

```bash
git add scripts/ddl-employees-department-nullable.sql src/ tests/unit/employee/department-optional.test.ts
git commit -m "feat(employee): department devient facultatif"
```

---

### Task 6: La modale ne demande plus que le poste

**Files:**
- Modify: `src/features/notification/infrastructure/handlers/profile-modal.ts` (`PROFILE_FIELDS`, `buildProfileModal`, `readProfileSubmission`, `profileSubmissionSchema`, suppression de `departmentSelect` et `startDatePicker`)
- Modify: `src/api/slack-interactions.route.ts` (`runOnboarding`, `handleViewSubmission`)
- Modify: `src/features/onboarding/application/workflows/employee-onboarding.ts` (schémas, corps de l'email)
- Test: `tests/unit/handlers/profile-modal.test.ts` (existant, à mettre à jour)

**Interfaces:**
- Consumes: `ProfileModalPrefill.joinedAt` (tâche 4), `department` nullable (tâche 5).
- Produces: `ValidatedProfile` sans `department` ni `startDate`.

- [ ] **Step 1: Écrire le test rouge**

```ts
import { describe, expect, it } from 'vitest';
import {
  buildProfileModal,
  profileSubmissionSchema,
} from '../../../src/features/notification/infrastructure/handlers/profile-modal';

describe('modale de profil', () => {
  it('ne demande QUE le poste — ni département, ni date de début', () => {
    const view = JSON.stringify(buildProfileModal({ slackUserId: 'U1' }));

    expect(view).toContain('profile_position');
    expect(view).not.toContain('profile_department');
    expect(view).not.toContain('profile_start_date');
    expect(view).not.toContain('datepicker');
    expect(view).not.toContain('static_select');
  });

  it('conserve email, prénom et nom, préremplis et éditables', () => {
    const view = JSON.stringify(
      buildProfileModal({
        slackUserId: 'U1',
        email: 'lea@kisso.com',
        firstName: 'Léa',
        lastName: 'Bamba',
      }),
    );

    expect(view).toContain('lea@kisso.com');
    expect(view).toContain('Léa');
    expect(view).toContain('Bamba');
  });

  it('valide une soumission à quatre champs', () => {
    const parsed = profileSubmissionSchema.safeParse({
      email: 'lea@kisso.com',
      firstName: 'Léa',
      lastName: 'Bamba',
      position: 'Software Engineer',
    });

    expect(parsed.success).toBe(true);
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npx vitest run tests/unit/handlers/profile-modal.test.ts`
Expected: FAIL — `profile_department` toujours présent.

- [ ] **Step 3: Implémenter**

`profile-modal.ts` :
- retirer `department` et `startDate` de `PROFILE_FIELDS`, `ProfileSubmission`, `readProfileSubmission`, `profileSubmissionSchema` ;
- supprimer `departmentSelect()` et `startDatePicker()` ;
- retirer les deux blocs de `buildProfileModal` ;
- **conserver `normalizeStartDate`** — la route l'applique désormais à la date d'arrivée. Mettre à jour son commentaire pour dire qu'elle borne au jour, pas à l'instant ;
- retirer l'import de `Department` s'il devient inutilisé.

Ajouter la dérivation de la date d'arrivée :

```ts
/**
 * Date de début, dérivée de l'arrivée Slack.
 *
 * Le sélecteur de date a disparu de la modale parce que la réponse est déjà connue : la
 * personne commence le jour où le workspace l'annonce. Le repli sur l'instant courant ne
 * concerne que les boutons émis AVANT ce lot, dont le `value` ne porte pas `joinedAt`.
 */
export function startDateFromJoin(joinedAt: string | null | undefined, now: Date): string {
  const parsed = joinedAt ? new Date(joinedAt) : null;
  const valid = parsed && !Number.isNaN(parsed.getTime()) ? parsed : now;
  return normalizeStartDate(valid.toISOString().slice(0, 10));
}
```

`slack-interactions.route.ts` — `runOnboarding` prend la date en paramètre et cesse de passer un département :

```ts
async function runOnboarding(
  mastra: Mastra,
  profile: ValidatedProfile,
  startDate: string,
): Promise<void> {
```

```ts
    inputData: {
      firstName: profile.firstName,
      lastName: profile.lastName,
      email: profile.email,
      // Plus JAMAIS renseigné : le parcours d'arrivée ne demande plus le département, et
      // `employees.department` est nullable depuis le 2026-08-13.
      department: null,
      position: profile.position,
      startDate,
      slackChannelId: null,
    },
```

`handleViewSubmission` lit `joinedAt` du `private_metadata` :

```ts
  const prefill = decodePrefill(payload.view.private_metadata, payload.user?.id ?? '');

  logger.info('Profile submission accepted', { slackUserId: prefill.slackUserId });

  const startDate = startDateFromJoin(prefill.joinedAt, new Date());

  const work = runOnboarding(mastra, parsed.data, startDate).catch((error: unknown) => {
    logger.error('Background onboarding failed', { error, email: parsed.data.email });
  });
```

⚠️ `buildProfileModal` doit donc porter `joinedAt` dans `private_metadata`, pas seulement `slackUserId` :

```ts
    private_metadata: JSON.stringify({ u: prefill.slackUserId, j: prefill.joinedAt ?? undefined }),
```

`employee-onboarding.ts` :
- `department: z.nativeEnum(Department).nullable().optional()` dans `onboardingInputSchema` ;
- `department: z.string().nullable()` dans `employeeCreatedSchema`, `onboardingInitializedSchema`, `welcomeSentSchema` ;
- `department: normalizedInput.department ?? null` à la création ;
- corps de l'email : remplacer la phrase citant le département par `<p>Nous sommes ravis de vous accueillir au sein de Kisso Industries.</p>` — un email de bienvenue ne doit pas dire « dans le département null ».

- [ ] **Step 4: Vérifier le vert**

Run: `npm run typecheck && npm run test:unit`
Expected: PASS. Corriger les tests existants qui construisent une soumission à six champs.

- [ ] **Step 5: Commit**

```bash
git add src/ tests/
git commit -m "feat(onboarding): la modale ne demande plus que le poste"
```

---

### Task 7: Câblage

**Files:**
- Modify: `src/mastra/index.ts`
- Modify: `.env.example` (si présent), `CLAUDE.md`, `CHANGELOG.md`, `TODO.md`

**Interfaces:**
- Consumes: tout ce qui précède.

- [ ] **Step 1: Câbler**

```ts
import { parseWelcomeChannelNames } from '../features/directory/domain/services/welcome-channel-names';
import { makeWelcomeChannels } from '../features/directory/application/services/welcome-channels.service';
import { SlackWelcomeChannelSource } from '../features/directory/infrastructure/providers/slack-welcome-channel.adapter';
```

```ts
/**
 * Invitation des arrivants aux canaux d'accueil.
 *
 * Construit au boot — celui qui est SUR le chemin des 3 secondes d'ACK de Slack —, donc
 * ZÉRO E/S ici : `parseWelcomeChannelNames` lit une variable d'environnement et l'adaptateur
 * ne fait qu'envelopper un client déjà instancié. Le premier appel réseau n'a lieu qu'au
 * premier `team_join`.
 */
export const welcomeChannels = makeWelcomeChannels({
  source: new SlackWelcomeChannelSource(slackWorkspaceService),
  channelNames: parseWelcomeChannelNames(process.env.ONBOARDING_WELCOME_CHANNELS),
});
```

Puis passer `welcomeChannels` dans les options du `SlackEventsHandler` construit par la route.
⚠️ Vérifier le nom réel de l'instance de `SlackWorkspaceService` dans `index.ts` et qu'elle expose bien `listChannels`, `inviteToChannel` et `joinChannel` ; sinon adapter `SlackInviteClient` à sa surface réelle.

- [ ] **Step 2: Vérifier**

Run: `npm run typecheck && npm run test:unit && npm run build`
Expected: tout vert, `verify:bundle` inclus.

- [ ] **Step 3: Documenter**

- `CLAUDE.md` : nouvelle variable `ONBOARDING_WELCOME_CHANNELS` dans le tableau ; section « parcours d'arrivée » ; `department` nullable ; prérequis `team_join` abonné + app réinstallée.
- `CHANGELOG.md` et `TODO.md` : entrées du lot.

- [ ] **Step 4: Poser la variable sur Vercel**

```bash
npx vercel env add ONBOARDING_WELCOME_CHANNELS production
# valeur : kisso-hq,random,signals,engineering-chat
```

- [ ] **Step 5: Commit**

```bash
git add src/mastra/index.ts CLAUDE.md CHANGELOG.md TODO.md
git commit -m "feat(onboarding): câblage du parcours d'arrivée"
```

---

## Prérequis humain — BLOQUANT

`team_join` doit être abonné dans *Event Subscriptions*, puis l'app **réinstallée**
(*Settings → Install App → Reinstall to Workspace*, jusqu'au bouton *Allow*). L'ajout seul ne
propage rien — piège déjà payé le 2026-08-08. Sans cela, `handleTeamJoin` est du code mort et
**aucune** tâche de ce plan ne produit d'effet observable, quel que soit le code déployé.

Le scope `channels:manage` est déjà accordé ; `conversations.invite` ne demande rien de plus.
