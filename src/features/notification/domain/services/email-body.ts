/**
 * LE CORPS D'UN EMAIL — un contrat qui était IMPLICITE, et que trois appelants sur quatre
 * violaient sans qu'aucun type ne bouge.
 *
 * ----------------------------------------------------------------------------
 * LE DÉFAUT
 * ----------------------------------------------------------------------------
 * `EmailProvider.sendEmail(to, subject, body: string)` ne disait pas ce qu'était `body`.
 * Les deux adaptateurs le placent pourtant dans un slot HTML — `html:` chez SMTP
 * (`smtp.adapter.ts`), `htmlContent:` chez Brevo. Le corps est donc INTERPRÉTÉ.
 *
 * Relevé le 2026-08-20, sur les quatre appelants :
 *
 *   welcome-email.ts        HTML délibéré, valeurs échappées par `esc()`      ✅ correct
 *   interview-email.ts      texte brut                                        ❌ interprété
 *   send-notification.ts    texte brut ÉCRIT PAR LE MODÈLE, 5 000 car.        ❌ interprété
 *   generate-document.ts    texte brut, titre interpolé                       ❌ interprété
 *
 * Le troisième est le grave : `body` est de la prose libre du modèle, atteignable depuis
 * un message Slack arbitraire. Un `<a href="https://…">Réinitialise ton mot de passe</a>`
 * partait en lien cliquable, DEPUIS L'ADRESSE DE L'ENTREPRISE, vers un salarié. Le produit
 * fabriquait lui-même le hameçonnage qu'il est censé ne pas rendre possible.
 *
 * ----------------------------------------------------------------------------
 * POURQUOI UN TYPE, ET NON UN ÉCHAPPEMENT DANS L'ADAPTATEUR
 * ----------------------------------------------------------------------------
 * Échapper systématiquement dans l'adaptateur aurait cassé `welcome-email.ts`, qui produit
 * du vrai HTML : le premier message que l'entreprise envoie à un arrivant aurait affiché
 * `<p>` littéralement. Et n'échapper que dans `send-notification` aurait laissé les deux
 * autres appelants ouverts — c'est-à-dire réparé UNE occurrence d'une classe de défaut, ce
 * que ce dépôt refuse de faire depuis qu'il a mesuré trois fois le contraire.
 *
 * Le type force chaque appelant à DÉCLARER ce qu'il produit. Un futur appelant qui
 * passerait une chaîne nue ne compilera pas : la règle n'est plus une consigne qu'on peut
 * oublier de lire, elle est vérifiée à la compilation. C'est la doctrine du dépôt —
 * une consigne est PROBABLE, le code est GARANTI.
 *
 * ⚠️ Ce module ne remplace PAS l'assainissement du contenu, et l'un ne couvre pas l'autre :
 * échapper `<script>` ne retire pas `https://evil.tld`, et retirer le lien n'empêche pas la
 * balise d'être interprétée. Voir `sanitizeNotificationBody` dans `shared/security/agent-output.ts`.
 */

/** Corps d'email, dans les deux formes que tout client attend. */
export interface EmailBody {
  /** Ce qui part en `html:` / `htmlContent:`. Toujours du HTML valide. */
  readonly html: string;
  /**
   * Repli texte brut. Certains clients refusent un message uniquement HTML, et sa présence
   * améliore le score anti-spam. Il était jusqu'ici DÉRIVÉ du HTML par retrait de balises,
   * ce qui mutilait tout corps de texte brut contenant `<…>` — second symptôme du même
   * contrat implicite.
   */
  readonly text: string;
}

/**
 * Échappement HTML minimal mais complet pour du contenu de TEXTE (jamais d'attribut).
 *
 * Les cinq caractères sont traités, `&` en PREMIER — l'inverse ré-échapperait les
 * esperluettes que les remplacements suivants viennent d'introduire, et `&lt;` deviendrait
 * `&amp;lt;`, visible tel quel par le destinataire.
 */
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Retire le balisage pour produire le repli texte.
 *
 * `[^>]+` ne peut pas reculer devant `>`, qu'il exclut de sa classe : le coût reste
 * linéaire sur une entrée non bornée. Même exigence que le reste du dépôt en matière de
 * ReDoS — voir `llm-guardrail-redos.test.ts`.
 */
function stripTags(html: string): string {
  return (
    html
      // eslint-disable-next-line sonarjs/super-linear-regex
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Un corps rédigé DÉLIBÉRÉMENT en HTML par un gabarit du serveur.
 *
 * ⚠️ N'échappe rien, par conception. Le seul appelant légitime est un gabarit qui échappe
 * lui-même ses valeurs interpolées (`welcome-email.ts` le fait avec `esc()`). Ne jamais
 * l'employer sur une valeur venue du modèle, d'un utilisateur ou de l'annuaire : ce serait
 * rouvrir exactement le défaut que ce module ferme, et sans laisser de trace.
 */
export function htmlEmailBody(html: string): EmailBody {
  return { html, text: stripTags(html) };
}

/**
 * Un corps de TEXTE BRUT. C'est le cas par défaut, et celui de toute prose écrite par un
 * modèle.
 *
 * Les sauts de ligne deviennent des `<br />` : sans cela un message rédigé en paragraphes
 * arrive en un seul bloc. Le défaut est cosmétique, mais il touchait CHAQUE notification et
 * il vient du même contrat implicite — le texte était livré à un moteur de rendu HTML, qui
 * ne connaît pas le retour à la ligne.
 */
export function textEmailBody(plain: string): EmailBody {
  return {
    html: escapeHtml(plain).replace(/\n/g, '<br />\n'),
    text: plain,
  };
}
