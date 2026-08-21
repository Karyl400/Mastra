/**
 * ════════════════════════════════════════════════════════════════════════════
 * L'EXÉCUTION D'UN OUTIL PAR HTTP EST FERMÉE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `mayTouchRecord` (`shared/slack-request-context.ts`) rend `true` quand aucun contexte Slack
 * n'accompagne l'appel. **Ce n'est pas un oubli** : c'est le cas normal du playground, d'un
 * workflow et d'un test, et « au tool de dégrader » est une décision écrite et justifiée.
 *
 * Mais Mastra expose `POST /api/tools/:toolId/execute` et
 * `POST /api/agents/:agentId/tools/:toolId/execute`. Derrière `MASTRA_API_TOKEN` — fail-closed,
 * mais **sans aucune règle RBAC déclarée**, donc le jeton vaut toutes les routes — un appelant
 * atteint ces chemins sans contexte Slack, et exécute alors `getEmployeeProfile`,
 * `generateDocument`, `sendNotification`, `scheduleReminder` ou `updateOnboardingStatus` sur
 * l'identifiant de n'importe qui.
 *
 * ⚠️ **C'est la moitié restée ouverte du correctif du 2026-08-14.** Celui-ci a fermé la FORGE
 * (`createRequestContextGuard` refuse toute clé `slack*` venue du corps) et laissé la VACANCE,
 * qui est strictement plus puissante : s'usurper exige de connaître les clés, ne rien déclarer
 * n'exige rien.
 *
 * ⚠️ **ON FERME LA ROUTE, PAS LE FAIL-OPEN.** Renverser `mayTouchRecord` ferait refuser les
 * chemins internes légitimes, et le symptôme serait un produit qui ne sait plus rien faire —
 * la panne que le garde d'autorisation évite déjà en refusant de s'appliquer tant qu'aucun
 * manager n'est désigné. Ce qu'il faut retirer, c'est la SURFACE : ces routes n'ont **aucun
 * consommateur** dans ce dépôt (zéro occurrence dans `src/`, `scripts/`, `tests/`). Une
 * capacité sans usage qui vaut l'usurpation totale n'est pas une capacité.
 *
 * ⚠️ **La frontière ne repose pas sur ce garde.** Le retirer un jour ramènerait à l'état du
 * 2026-08-20, pas plus bas. Il ferme une porte ; il ne porte pas la serrure.
 */

/** 403 et non 401 : l'appelant est authentifié, c'est la capacité qui n'existe pas pour lui. */
const FORBIDDEN = 403;

/**
 * ⚠️ **AUCUNE EXPRESSION RÉGULIÈRE ICI, et c'est délibéré.**
 *
 * La première version était `/\/api\/(?:agents\/[^/]+\/)?tools\/[^/]+\/execute$/i` — deux
 * classes répétées de part et d'autre d'un groupe optionnel, donc un motif que `eslint` signale
 * en `detect-unsafe-regex` et `super-linear-regex`. Ce dépôt a déjà mesuré et corrigé un lot
 * ReDoS ; poser un motif à backtracking sur un chemin **contrôlé par l'appelant**, dans un garde
 * de sécurité, aurait été rouvrir la porte à côté de celle qu'on ferme.
 *
 * Un découpage en segments est linéaire par construction, et il se lit mieux : on veut
 * `…/tools/<x>/execute`, éventuellement précédé de `agents/<y>`.
 *
 * ⚠️ **La normalisation précède la décision.** Le chemin vient d'une URL que l'appelant écrit :
 * tout ce que le serveur normaliserait SANS que le garde le voie serait un contournement. Les
 * segments vides absorbent d'un coup le slash de fin, les slashs doublés et le `?…`.
 */
export function isToolExecutionPath(rawPath: string): boolean {
  const segments = (rawPath.split('?')[0] ?? '')
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());

  const last = segments.length - 1;
  // `…/tools/<toolId>/execute` — au minimum `api`, `tools`, `<id>`, `execute`.
  if (segments.length < 4) return false;
  if (segments[0] !== 'api') return false;
  if (segments[last] !== 'execute') return false;
  if (segments[last - 2] !== 'tools') return false;

  // Deux formes exposées par Mastra, et deux seulement : `/api/tools/<id>/execute`
  // et `/api/agents/<agentId>/tools/<id>/execute`.
  if (segments.length === 4) return true;
  return segments.length === 6 && segments[1] === 'agents';
}

interface GuardedContext {
  req?: { path?: string; raw?: Request };
}

function pathOf(c: unknown): string {
  const req = (c as GuardedContext)?.req;
  if (typeof req?.path === 'string') return req.path;
  const url = req?.raw?.url;
  if (typeof url === 'string') {
    try {
      return new URL(url).pathname;
    } catch {
      return '';
    }
  }
  return '';
}

export function createToolExecutionGuard(options: { onReject?: (path: string) => void }) {
  return async (c: unknown, next: () => Promise<void>): Promise<Response | void> => {
    const path = pathOf(c);

    if (!isToolExecutionPath(path)) {
      await next();
      return;
    }

    options.onReject?.(path);

    return new Response(
      JSON.stringify({
        error:
          'Executing a tool over HTTP is disabled. Tools carry no requester identity on this ' +
          'path, so the authorisation boundary cannot be applied. Use Slack, which is the only ' +
          'legitimate producer of the request context these tools rely on.',
      }),
      { status: FORBIDDEN, headers: { 'content-type': 'application/json' } },
    );
  };
}
