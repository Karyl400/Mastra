/**
 * ⚠️ MARCEL — LE NOM SOUS LEQUEL CE PRODUIT PARLE AUX GENS.
 *
 * Jusqu'au 2026-08-21, l'assistant n'avait aucun nom. Il se désignait par la société
 * (« Kisso ») ou, pire, par sa nature : « Je suis un outil d'onboarding ». Une personne qui
 * écrit à quelqu'un sans nom n'écrit à personne, et le premier message de l'entreprise à un
 * arrivant ouvrait par une phrase sur la machine plutôt que sur lui.
 *
 * ⚠️ CE NOM N'EST PAS `KISSO-AGENT-v3`, et il ne faut surtout pas les confondre.
 *   • `KISSO-AGENT-v3` est un identifiant INTERNE, verrouillé par la DIRECTIVE 1.1 et
 *     CENSURÉ en sortie par `INTERNAL_MARKERS.agent_identity` : toute réponse qui le contient
 *     est remplacée en bloc. Il ne doit jamais sortir.
 *   • « Marcel » est un nom d'affichage, destiné à sortir à chaque conversation.
 * Le second n'affaiblit en rien le premier — un prénom ne renseigne aucun attaquant sur la
 * configuration interne, là où l'identifiant de version en dit long.
 *
 * ⚠️ NOMMER N'EST PAS MENTIR. Marcel ne se présente pas comme un automate ; il ne prétend pas
 * non plus être un être humain, et rien ici ne l'y invite. La consigne de style est une
 * INTERDICTION DE S'AUTO-DÉSIGNER COMME OUTIL, pas une instruction de revendiquer une
 * humanité. La distinction porte : dans le message de détresse, il dit toujours qu'il n'est
 * pas la bonne personne — parce qu'à cet endroit, laisser croire le contraire nuirait.
 */
export const ASSISTANT_NAME = 'Marcel';

export const COMPANY_NAME = 'Kisso';

/**
 * ⚠️ LA GARANTIE EST ICI, PAS DANS LE PROMPT.
 *
 * Doctrine du dépôt, vérifiée trois fois en production : « une consigne est PROBABLE, le code
 * est GARANTI. » Le bloc STYLE demande au modèle de ne pas s'annoncer comme un outil ; ces
 * motifs permettent à un test de le VÉRIFIER sur tous les textes que le dépôt écrit lui-même,
 * qui sont les seuls sur lesquels une garantie soit possible.
 *
 * ⚠️ Ils ne servent PAS à filtrer la sortie du modèle. Réécrire « je suis un assistant » au
 * vol produirait des phrases estropiées, et un filtre qui mutile est pire qu'une consigne qui
 * échoue parfois — c'est le raisonnement qui a fait garder le document plutôt que le remplacer
 * quand un marqueur y est détecté.
 */
export const MACHINE_SELF_DESIGNATIONS: readonly RegExp[] = [
  /\bje suis (?:un |une )?(?:outil|agent|bot|robot|assistant|ia|intelligence artificielle)\b/i,
  /\ben tant qu(?:'|e )(?:outil|agent|bot|robot|assistant|ia)\b/i,
  /\bassistant (?:virtuel|automatique|conversationnel)\b/i,
  /\bje suis (?:un )?programme\b/i,
  // `(?:a |an )?` et non `(?:an? )?` : le second imbrique un quantificateur dans un groupe
  // optionnel, ce que `security/detect-unsafe-regex` signale. Même langage reconnu.
  /\bi(?:'m| am) (?:a |an )?(?:tool|bot|robot|assistant|ai|chatbot)\b/i,
];

export function namesItselfAsMachine(text: string): boolean {
  return MACHINE_SELF_DESIGNATIONS.some((pattern) => pattern.test(text));
}
