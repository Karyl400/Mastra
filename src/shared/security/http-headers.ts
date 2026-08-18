/**
 * Les en-têtes de sécurité HTTP, posés sur TOUTE réponse du serveur.
 *
 * ## Ce que la campagne du 2026-08-18 a relevé
 *
 * Sondé de l'extérieur sur `https://mastra-71ya.vercel.app` : la réponse ne portait
 * `strict-transport-security` (posé par Vercel, pas par ce code) et **rien d'autre**. Ni
 * `x-content-type-options`, ni `x-frame-options`, ni `referrer-policy`.
 *
 * ⚠️ **La portée réelle est modeste, et il faut le dire** : ce serveur n'a pas d'application
 * web. `/api/*` rend du JSON derrière un jeton porteur, `/slack/events` répond à Slack de
 * serveur à serveur. Ce ne sont donc pas des correctifs de faille — aucun scénario
 * d'exploitation n'a été trouvé. Ce qui existe bel et bien, c'est une surface HTML : la
 * racine et `/agents` rendent `text/html` en 200 (page d'accueil du serveur Mastra). C'est
 * elle qui justifie `x-frame-options`, et elle seule.
 *
 * On les pose quand même partout : le coût est de trois en-têtes constants, et la règle
 * « pas de configuration conditionnelle » vaut ici comme ailleurs dans ce dépôt — une
 * protection montée sous condition est un interrupteur qu'on oublie.
 *
 * ## Ce qui n'est PAS posé, et pourquoi
 *
 * - **Aucune `Content-Security-Policy`.** La page HTML n'est pas la nôtre : elle vient du
 *   serveur Mastra et embarque son propre style en ligne. Une CSP écrite à l'aveugle la
 *   casserait au premier `style-src`, et nous n'avons aucun moyen de la tester autrement
 *   qu'en production. Une CSP fausse est pire qu'aucune : elle donne l'illusion du contrôle.
 * - **Aucun `Permissions-Policy`.** Il n'y a ni caméra, ni micro, ni géolocalisation dans ce
 *   produit. L'ajouter serait du bruit de checklist.
 */
/**
 * ⚠️ Le contexte est typé `unknown` puis restreint, comme `createRequestContextGuard` et
 * `createAgentApiGuard`. Importer `Context` de `hono` ici ferait échouer la compilation sur
 * une incompatibilité de génériques entre le Hono du dépôt et celui que `@mastra/core`
 * embarque — et surtout, `shared/` n'a aucune raison de dépendre d'un framework HTTP.
 */
interface ResponseCarrier {
  res: Response;
}

/**
 * ⚠️ `nosniff` est le seul des trois qui protège une réponse d'API. Sans lui, un JSON dont le
 * contenu est écrit par un tiers (un nom d'affichage Slack, le corps d'un document) peut être
 * ré-interprété en HTML par un navigateur qui devine le type — et le contenu de ce produit est
 * précisément du texte rédigé par des humains et par un modèle.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  // La page d'accueil du serveur Mastra n'a aucune raison d'être encadrée ailleurs.
  'x-frame-options': 'DENY',
  // `no-referrer` et non `strict-origin-when-cross-origin` : ce serveur ne fait aucun lien
  // sortant vers un tiers, il n'y a donc rien à ménager et l'origine elle-même est une
  // information de moins à divulguer.
  'referrer-policy': 'no-referrer',
};

/**
 * ⚠️ **ASSIGNE `c.res`, NE RETOURNE PAS.** Dans Hono, la valeur de retour d'un middleware
 * n'est prise en compte que s'il N'A PAS appelé `next()`. Ce piège a déjà rendu deux
 * middlewares de ce dépôt inopérants — `createCallerErrorMiddleware` depuis son écriture, et
 * la rédaction de sortie de `createAgentApiGuard`, qui laissait le prompt système fuir par un
 * simple GET pendant que ses tests, qui assertaient le RETOUR, restaient au vert.
 *
 * `c.res.headers` est mutable dans Hono (la réponse est reconstruite à l'affectation), mais on
 * ne s'y fie pas : on reconstruit explicitement, ce qui vaut pour toute réponse, y compris
 * celles produites par un autre middleware.
 */
export function createSecurityHeadersMiddleware() {
  return async (context: unknown, next: () => Promise<void>): Promise<void> => {
    await next();

    const c = context as ResponseCarrier;
    if (!c?.res) return;

    const headers = new Headers(c.res.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);

    c.res = new Response(c.res.body, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers,
    });
  };
}
