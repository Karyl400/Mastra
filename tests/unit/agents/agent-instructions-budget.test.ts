/**
 * Garde-fou sur le PRÉFIXE d'instructions des trois agents.
 *
 * Le préfixe système est réémis à CHAQUE aller-retour avec le modèle (2-3 fois
 * sur un flux avec appel d'outil). La contrainte réelle mesurée sur les logs de
 * production du 2026-08-11 n'est pas le seau par minute (il était PLEIN au
 * moment de l'incident) mais le plafond JOURNALIER de Groq — `TPD: Limit
 * 100000` — soit ≈ 19 messages par jour tous canaux confondus. Chaque token
 * d'instruction économisé ici est donc multiplié par le nombre d'allers-retours
 * ET rend directement des messages à la journée.
 *
 * Trois propriétés sont verrouillées :
 *   1. le bloc STYLE reste COURT — et partagé, pour n'avoir qu'un endroit à
 *      raccourcir la prochaine fois ;
 *   2. le raccourcissement n'a emporté aucune des consignes issues d'une
 *      régression réelle en production (tutoiement, mrkdwn, pas d'emojis, pas de
 *      « prochaines étapes », pas de récitation de capacités, secret de
 *      l'identifiant interne, anti-invention) ;
 *   3. chaque agent porte une FRONTIÈRE NÉGATIVE dérivée de son câblage.
 *
 * ⚠️ Sur le point 2, une protection a CHANGÉ DE SUPPORT le 2026-08-11 sans être
 * abandonnée : « pas de markdown GitHub » et « pas d'emojis » ne sont plus dans
 * le texte du bloc STYLE, ils sont garantis par `sanitizeAgentOutput`, point de
 * passage unique de toute réponse d'agent. L'assertion correspondante a donc été
 * RÉÉCRITE sur le code, pas supprimée.
 *
 * ⚠️ Mais cette garantie ne couvre QUE le chemin Slack : les ARGUMENTS de tool
 * n'y passent jamais. Le `content` d'un document part donc sans filtre — emojis
 * rendus en carrés `.notdef` par Roboto, markdown imprimé en toutes lettres.
 * La consigne « ni markdown ni emoji » est donc réintroduite là, et là seulement :
 * dans le bloc DOCUMENTS de l'agent qui porte `generateDocument`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { makeOnboardingOrchestrator } from '../../../src/features/onboarding/application/agents/onboarding-orchestrator';
import { makeNotificationAgent } from '../../../src/features/notification/application/agents/notification-agent';
import {
  AGENT_STYLE_BLOCK,
  AGENT_ANTI_INVENTION_BLOCK,
  agentToolBoundary,
} from '../../../src/shared/agent-style';
import { sanitizeAgentOutput } from '../../../src/shared/security/agent-output';
import { AGENT_TOOLS } from '../../../src/shared/agent-capabilities';

const CHARS_PER_TOKEN = 3.5;
const tok = (s: string) => Math.round(s.length / CHARS_PER_TOKEN);

/**
 * Câblage RÉEL de `src/mastra/index.ts` — **importé**, plus recopié.
 *
 * ⚠️ Cette constante était rédigée à la main ici, et elle a dérivé DEUX FOIS : elle nommait
 * encore `evaluateResponse` (décâblé le 2026-08-12) et ignorait `findEmployeeByEmail` sur deux
 * agents sur trois, si bien que toute mesure de budget qui s'y fiait sous-estimait le total.
 * `CLAUDE.md` le signalait, `_measure.mts` portait la même copie périmée, et personne ne
 * pouvait le voir : un jeu d'essai qui ment sur le câblage finit par servir de référence.
 *
 * Depuis le 2026-08-14 la source est UNIQUE (`src/shared/agent-capabilities.ts`) et elle est
 * partagée avec le ROUTAGE, qui s'en sert pour décider si l'agent d'un fil peut servir la
 * demande. Une divergence casse donc un routage vérifié par test, au lieu de fausser un
 * chiffre en silence.
 */
const WIRING = AGENT_TOOLS;

const toolsOf = (names: readonly string[]) =>
  Object.fromEntries(names.map((n) => [n, {}])) as Record<string, never>;

const agents = [
  ['onboardingOrchestrator', makeOnboardingOrchestrator],
  ['notificationAgent', makeNotificationAgent],
] as const;

async function instructionsOf(
  make: (tools: Record<string, never>) => { getInstructions: () => unknown },
  tools: Record<string, never> = {} as Record<string, never>,
) {
  return String(await make(tools).getInstructions());
}

beforeEach(() => {
  vi.stubEnv('GROQ_API_KEY', 'test-groq-key');
  vi.stubEnv('MISTRAL_API_KEY', 'test-mistral-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Blocs partagés STYLE / ANTI-INVENTION', () => {
  it('tient le bloc STYLE sous 100 tokens', () => {
    // Mesure avant le premier dégraissage : ~170 tokens, répliqués dans chacun des
    // 3 agents. Puis 81, puis 86. Aujourd'hui 78 — et il porte DEUX consignes de
    // plus qu'alors (pas d'exclamation, distinction interlocuteur / sujet).
    const tokens = tok(AGENT_STYLE_BLOCK);
    expect(tokens, `bloc STYLE de ${tokens} tokens`).toBeLessThan(100);
  });

  it('ne coûte pas plus que la version qu il remplace, malgré deux consignes de plus', () => {
    // Le lot « espace négatif » AJOUTE une frontière à chaque agent. Elle doit être
    // FINANCÉE, pas empilée : les blocs partagés ne doivent donc pas grossir.
    // Références mesurées avant le lot : STYLE 86 tokens, ANTI-INVENTION 88.
    expect(tok(AGENT_STYLE_BLOCK), 'bloc STYLE').toBeLessThanOrEqual(86);
    expect(tok(AGENT_ANTI_INVENTION_BLOCK), 'bloc ANTI-INVENTION').toBeLessThanOrEqual(88);
  });

  it('conserve chaque consigne de style issue d une régression de production', () => {
    // « TUTOIEMENT » (nom) est devenu « Tutoie ton interlocuteur » (verbe + cible) :
    // l'assertion est réécrite sur le nouveau texte, pas supprimée. Le tutoiement
    // reste imposé ; ce qui change est qu'il DÉSIGNE désormais quelqu'un.
    expect(AGENT_STYLE_BLOCK).toMatch(/tutoie/i);
    expect(AGENT_STYLE_BLOCK).toContain('prochaines étapes');
    // Les réponses de production récitaient des listes de capacités avant de répondre.
    // Aucun filtre de sortie ne sait corriger cela : seul le texte le peut.
    expect(AGENT_STYLE_BLOCK).toMatch(/récit/i);
    // ⚠️ Assertion INVERSÉE le 2026-08-12, après mesure en production.
    //
    // Le bloc nommait la chaîne interdite pour l'interdire. Or `sanitizeAgentOutput`
    // traite `KISSO-AGENT-v\d+` comme un marqueur interne et REMPLACE la réponse entière
    // dès qu'il apparaît : la consigne était donc le premier fournisseur, dans le contexte
    // du modèle, de la chaîne qui détruit ses propres réponses. Sous repli Mistral — moins
    // docile que Groq sur la non-répétition du prompt — cette boucle s'est refermée deux
    // fois sur des demandes parfaitement anodines.
    //
    // La garantie n'est pas affaiblie : elle vit dans le code, pas dans le prompt.
    expect(
      AGENT_STYLE_BLOCK,
      "le bloc STYLE ne doit plus NOMMER l'identifiant d'agent — voir agent-style.ts",
    ).not.toContain('KISSO-AGENT-v3');
  });

  it('distingue l interlocuteur du sujet dont on parle', () => {
    // A1/A2 en production : « Ton profil », « Tu as 5 tâches » — alors que la
    // question portait sur un TIERS. Le bloc imposait « TUTOIEMENT » sans jamais
    // dire QUI tutoyer ; le « tu » ne pouvait se résoudre que sur la seule personne
    // nommée dans le contexte, c'est-à-dire le sujet de la requête.
    expect(AGENT_STYLE_BLOCK).toMatch(/interlocuteur/i);
    expect(AGENT_STYLE_BLOCK).toMatch(/sujet/i);
  });

  it('bannit les marqueurs d enthousiasme et les plans numérotés', () => {
    // Constat de l'utilisatrice testeuse (responsable RH) : « les points
    // d'exclamation arrivent précisément dans les phrases où il ne fait rien », et
    // « Je te propose : 1. … 2. … » en réponse à une demande de dix mots.
    expect(AGENT_STYLE_BLOCK).toMatch(/exclamation/i);
    expect(AGENT_STYLE_BLOCK).toMatch(/numérotée/i);
  });

  /**
   * Ancienne assertion : le bloc STYLE devait CONTENIR « mrkdwn Slack », « markdown
   * GitHub » et « emoji ». Ces trois consignes ont quitté le texte le 2026-08-11 —
   * pas la protection.
   *
   * Le déplacement est justifié : une instruction ne peut que DEMANDER au modèle de
   * ne pas produire de markdown GitHub, et la campagne du 2026-08-10 a montré qu'il
   * en produisait malgré l'interdiction explicite. `sanitizeAgentOutput` le
   * GARANTIT, au point de passage unique de toute réponse d'agent.
   *
   * L'assertion est donc réécrite ici même, et pas seulement déléguée à
   * `tests/unit/security/agent-output.test.ts` : c'est ce qui empêche qu'un futur
   * allègement de `sanitizeAgentOutput` fasse disparaître la règle des DEUX supports
   * à la fois, sans qu'aucun test de style ne rougisse.
   */
  it('délègue au code la conversion mrkdwn et le retrait des emojis', () => {
    const cleaned = sanitizeAgentOutput('## Bilan\n\n**Fait** :wave: et livré 🎉\n\n---\n');

    expect(cleaned.text).toContain('*Bilan*');
    expect(cleaned.text).toContain('*Fait*');
    expect(cleaned.text).not.toContain('**');
    expect(cleaned.text).not.toContain(':wave:');
    expect(cleaned.text).not.toContain('🎉');
    expect(cleaned.text).not.toContain('---');
  });

  it('interdit explicitement d inventer une URL, un lien ou un chemin de fichier', () => {
    // Trou par lequel est passé le faux lien https://kisso.internal/docs/<uuid>/download.
    expect(AGENT_ANTI_INVENTION_BLOCK).toContain('URL');
    expect(AGENT_ANTI_INVENTION_BLOCK).toContain('lien');
    expect(AGENT_ANTI_INVENTION_BLOCK).toContain('chemin de fichier');
    // Sans régresser sur la liste d'origine.
    for (const champ of ['prénom', 'nom', 'email', 'identifiant', 'date', 'score']) {
      expect(AGENT_ANTI_INVENTION_BLOCK).toContain(champ);
    }
    expect(AGENT_ANTI_INVENTION_BLOCK).toContain('emailSent: false');
  });
});

/**
 * FRONTIÈRE NÉGATIVE — l'espace négatif du câblage.
 *
 * Un `Agent` Mastra ne reçoit qu'une ÉNUMÉRATION POSITIVE de ses tools ; il ne
 * reçoit jamais le complément. Toute la campagne du 2026-08-11 l'a payé : « je
 * peux lui renvoyer le lien » (aucun tool n'envoie de lien), « donne-moi son email
 * pro » (aucun tool ne consomme un email sur cet agent), « je ne peux pas modifier
 * un questionnaire qu'elle n'a pas reçu » (règle métier entièrement inventée —
 * aucun tool de modification n'existe), un rappel « programmé pour lundi 9h »
 * proposé par un agent qui n'a pas `scheduleReminder`.
 *
 * Preuve par contraste : A3 est le SEUL refus correct de la campagne, et c'est la
 * seule frontière qui était écrite noir sur blanc dans un prompt.
 *
 * La frontière est DÉRIVÉE de `Object.keys(tools)` et non rédigée : ce dépôt a
 * déjà connu des instructions qui nommaient des tools retirés depuis
 * (`discoverSlackWorkspace`, `createEmployee`). Une liste écrite à la main se
 * désynchronise au premier changement de câblage ; celle-ci ne le peut pas.
 */
describe('Frontière négative dérivée du câblage', () => {
  it('énumère exactement les clés de l objet tools, dans leur ordre de câblage', () => {
    expect(agentToolBoundary({ beta: {}, alpha: {} })).toBe(
      "TES SEULS OUTILS : beta, alpha. Rien d'autre n'existe ni n'a existé : dis-le, n'invente " +
        'rien. Pas de service générique (traduction, rédaction libre, code).',
    );
  });

  it('parle aussi du PASSÉ — la question à prémisse fausse', () => {
    // « pourquoi as-tu supprimé le compte de Awa ? » : aucun tool de suppression n'a jamais
    // été câblé, mais la frontière ne parlait qu'au présent. Le modèle pouvait s'excuser
    // d'une action qu'il n'a pas pu commettre — avec l'assurance dont ce dépôt sait déjà
    // qu'elle ne distingue pas le fait de la narration.
    expect(agentToolBoundary({ getTaskList: {} })).toContain("n'a existé");
  });

  it("déclare la frontière MÉTIER, que l'énumération des tools ne couvre pas", () => {
    // Poème, traduction, code : la RÈGLE ANTI-INVENTION ne les rattrape pas (elle interdit
    // d'inventer une DONNÉE absente, or il n'y a ici aucune donnée à inventer). Sans cette
    // clause, le modèle obtempère et brûle un tour entier.
    expect(agentToolBoundary({ getTaskList: {} })).toContain('traduction');
  });

  it("ÉNUMÈRE ce qu'elle refuse, au lieu d'exiger une appartenance à un domaine", () => {
    // ⚠️ Garde-fou de rédaction. Les quatre agents ont quatre domaines distincts : une
    // consigne du type « refuse ce qui sort de l'onboarding » ferait refuser à
    // `notificationAgent` un rappel parfaitement légitime. Et « ce qui sort de ton rôle »
    // est pire — ce dépôt sait ce qu'un modèle met dans un espace laissé vide.
    const frontiere = agentToolBoundary({ sendNotification: {} });

    expect(frontiere).not.toMatch(/sort de (l'onboarding|ton rôle|ton domaine)/);
    expect(frontiere).toContain('Pas de service générique');
  });

  it('suit un ajout de tool sans la moindre retouche de texte', () => {
    // Un autre lot expose `findEmployeeByEmail` à `questionnaireEngine` et
    // `notificationAgent`. La frontière doit rester JUSTE après ce changement,
    // sans qu'aucune phrase n'ait à être réécrite.
    const avant = agentToolBoundary({ generateQuestionnaire: {} });
    const apres = agentToolBoundary({ generateQuestionnaire: {}, findEmployeeByEmail: {} });

    expect(avant).not.toContain('findEmployeeByEmail');
    expect(apres).toContain('findEmployeeByEmail');
  });

  it('reste lisible quand aucun tool n est câblé', () => {
    // `make({})` est le cas des tests de construction : la phrase doit rester une
    // phrase française, pas « TES SEULS OUTILS : . ».
    expect(agentToolBoundary({})).toContain('aucun');
    expect(agentToolBoundary({})).not.toContain(' : .');
  });

  it('coûte quelques dizaines de tokens, pas une centaine', () => {
    // Mesuré sur le câblage réel le plus lourd (5 tools). Le préfixe est repayé à
    // chaque aller-retour : une frontière à 100 tokens coûterait plus cher que le
    // défaut qu'elle corrige.
    // Seuil relevé de 60 à 70 le 2026-08-13, avec les deux clauses ajoutées (passé +
    // frontière métier) : ≈ +15 tokens. L'objet du test est « quelques dizaines, pas une
    // centaine » — il n'est pas de figer un chiffre, mais d'empêcher que cette phrase
    // devienne un paragraphe. Un seul run hors-sujet évité rembourse l'ajout pour une semaine.
    //
    // Relevé de 70 à 80 le 2026-08-19 : `findExpertise` est exposé à l'orchestrateur, donc son
    // NOM entre dans la frontière — 70 → 74 tokens mesurés. La croissance est ici la
    // contrepartie DIRECTE de la capacité ajoutée, et elle est bornée par construction : la
    // frontière est dérivée de `Object.keys(tools)`, elle ne peut grandir que d'un nom d'outil
    // à la fois, jamais d'une phrase.
    const tokens = tok(agentToolBoundary(toolsOf(WIRING.onboardingOrchestrator)));
    expect(tokens, `frontière de ${tokens} tokens`).toBeLessThan(80);
  });
});

describe.each(agents)('%s — instructions', (id, make) => {
  it('reprend les blocs partagés STYLE et ANTI-INVENTION', async () => {
    const instructions = await instructionsOf(make as never);

    expect(instructions).toContain(AGENT_STYLE_BLOCK);
    expect(instructions).toContain(AGENT_ANTI_INVENTION_BLOCK);
  });

  it('ne conserve aucune variante locale du bloc STYLE', async () => {
    const instructions = await instructionsOf(make as never);
    // Une seule ouverture de bloc STYLE : la version partagée. Le motif est ancré en
    // début de ligne et tolère l'ancien libellé « STYLE (Slack) » comme le nouveau
    // « STYLE : » — ce qui compte est le NOMBRE d'ouvertures, pas leur formulation :
    // une seconde signalerait le retour d'une variante recopiée dans un agent.
    expect(instructions.match(/^STYLE\b/gm)).toHaveLength(1);
    expect(instructions.match(/RÈGLE ANTI-INVENTION/g)).toHaveLength(1);
  });

  it('porte la frontière négative DÉRIVÉE de ses propres tools', async () => {
    // Le test injecte un câblage arbitraire : si la phrase était écrite à la main
    // dans le fichier de l'agent, elle ne pourrait pas contenir ces noms-là.
    const tools = toolsOf(['toolPremier', 'toolSecond']);
    const instructions = await instructionsOf(make as never, tools);

    expect(instructions).toContain(agentToolBoundary(tools));
  });

  it('porte la frontière négative correspondant à son câblage réel', async () => {
    const tools = toolsOf(WIRING[id]);
    const instructions = await instructionsOf(make as never, tools);

    for (const name of WIRING[id]) expect(instructions).toContain(name);
    expect(instructions).toContain(agentToolBoundary(tools));
  });
});

/**
 * Le bloc DOCUMENTS a été RÉÉCRIT le 2026-08-11 — et ces assertions avec lui.
 *
 * Il disait : « generateDocument ENREGISTRE le document ; il ne renvoie AUCUN fichier
 * téléchargeable ni URL (l'envoi d'un PDF n'est pas encore branché) ». C'était le constat
 * exact d'un vide fonctionnel : aucun tool d'agent ne produisait de fichier, et c'est ce
 * vide qui a fabriqué le faux lien `https://kisso.internal/docs/<uuid>/download`.
 *
 * Le vide est comblé : `generateDocument` rend un PDF ou un DOCX, l'uploade dans le fil
 * Slack ou l'envoie en pièce jointe, et rend un verdict de livraison. L'ancienne
 * assertion (« aucun fichier téléchargeable ») ne pouvait donc PAS être conservée sans
 * verrouiller une consigne devenue fausse, qui aurait bridé la capacité.
 *
 * Ce qui la remplace couvre les mêmes risques, sur les faits nouveaux :
 *   • l'interdiction d'inventer un lien reste, mot pour mot — le fichier est livré par
 *     UPLOAD, aucune URL de téléchargement n'existe dans ce système ;
 *   • l'agent doit LIRE le verdict `delivery` au lieu de supposer, seule façon de dire
 *     « le document est prêt mais je n'ai pas pu te l'envoyer » quand la livraison échoue ;
 *   • le contenu du document ne traverse AUCUN filtre — voir l'en-tête de ce fichier ;
 *   • le budget est mesuré, pas estimé.
 */
describe('onboardingOrchestrator — promesses de documents', () => {
  /**
   * Longueur de référence. Le bloc valait 203 caractères avant sa réécriture, puis
   * 198. Il en vaut 258 depuis qu'il porte la seule contrainte existante sur le
   * CONTENU d'un document — le plafond est relevé d'exactement ce qu'a coûté cette
   * phrase, et l'agent reste sous son FLOOR (mesure dans le rapport de lot).
   */
  const PLAFOND_CHARS = 280;

  async function documentsBlock() {
    const instructions = await instructionsOf(makeOnboardingOrchestrator as never);
    const bloc = instructions.match(/^DOCUMENTS :.*$/m);
    expect(bloc, 'bloc DOCUMENTS introuvable dans les instructions').not.toBeNull();
    return bloc![0];
  }

  it('décrit la capacité réelle : un fichier rendu ET livré', async () => {
    const bloc = await documentsBlock();

    expect(bloc).toContain('generateDocument');
    expect(bloc).toMatch(/pdf/i);
    expect(bloc).toMatch(/docx/i);
    expect(bloc).toMatch(/deliverTo/);
    expect(bloc).toMatch(/slack/i);
    expect(bloc).toMatch(/email/i);
  });

  it('fait reposer l annonce sur le verdict de livraison, pas sur une supposition', async () => {
    const bloc = await documentsBlock();

    expect(bloc).toContain('delivery');
    // « prêt mais non livré » est l'énoncé honnête quand la livraison échoue.
    expect(bloc).toMatch(/non livré/i);
  });

  it('conserve mot pour mot l interdiction d inventer un lien', async () => {
    // Le fichier arrive par upload : il n'existe AUCUNE URL de téléchargement à citer.
    expect(await documentsBlock()).toMatch(/n'invente jamais de lien/i);
  });

  it('demande au modèle de RÉDIGER le contenu, et ne parle plus de markdown', async () => {
    // ⚠️ CE TEST A ÉTÉ INVERSÉ le 2026-08-19, et il faut dire pourquoi plutôt que de le
    // supprimer. Il exigeait « ni markdown ni emoji » dans le bloc. Deux mesures ont retourné
    // la décision :
    //
    //  1. **La consigne était REDONDANTE avec le code.** `document-template.ts` TRADUIT le
    //     markdown (`#` → titre, `- ` → puce), élimine `**gras**` et retire les emojis. Le
    //     motif d'origine — « les emojis sortent en glyphe .notdef, le markdown s'imprime
    //     littéralement » — décrivait l'état d'AVANT ce traducteur. On payait donc des tokens
    //     à chaque aller-retour pour une contrainte que le rendu applique de toute façon.
    //  2. **Elle a FUITÉ vers l'utilisateur.** Production, 2026-08-19, « Génère-moi le guide
    //     d'accueil en PDF » → « Peux-tu me fournir le contenu (sans markdown ni emoji) ? ».
    //     Une contrainte de rendu interne remontée telle quelle à un humain — dans la phrase
    //     même par laquelle le modèle refusait de faire le travail.
    //
    // La place ainsi libérée porte la consigne qui manquait, et c'est le SECOND volet du même
    // relevé : le `.describe()` de `content` disait « rédige-le, ne le demande pas » depuis le
    // 2026-08-18 et le modèle a redemandé — cinq mots ne pèsent pas face à
    // `AGENT_ANTI_INVENTION_BLOCK`, qui est dans le prompt.
    const bloc = await documentsBlock();

    expect(bloc).toMatch(/rédige/i);
    expect(bloc).toMatch(/ne le demande jamais/i);
    // La contrainte de rendu ne remonte plus dans une phrase adressée à un humain.
    expect(bloc).not.toMatch(/markdown/i);
  });

  // ⚠️ Relevé de 260 à 280 le 2026-08-19. L'échange est explicite et il faut pouvoir le
  // vérifier : « Dans `content` : ni markdown ni emoji. » (39 caractères, redondant avec le
  // rendu et qui a fui vers un humain) sort ; « Rédige `content` TOI-MÊME, ne le demande
  // jamais. » (47) entre. Net +8 caractères, soit ≈ 2 tokens par aller-retour, contre un
  // aller-retour ENTIER — ≈ 1 500 tokens — perdu à chaque fois que le modèle réclame le texte.
  // Le reste de l'écart tient au plafond, qui n'avait plus de marge : il en retrouve un peu.
  it('ne coûte pas plus cher que le plafond mesuré', async () => {
    const bloc = await documentsBlock();
    const tokens = Math.round(bloc.length / CHARS_PER_TOKEN);

    expect(
      bloc.length,
      `bloc DOCUMENTS de ${bloc.length} caractères (${tokens} tokens), plafond ${PLAFOND_CHARS}`,
    ).toBeLessThanOrEqual(PLAFOND_CHARS);
  });
});

/**
 * Ce que l'orchestrateur ne doit PLUS dire.
 *
 * Ces deux assertions protègent une SUPPRESSION. Sans elles, la ligne reviendrait
 * à la première relecture qui la trouverait « utile ».
 */
describe('onboardingOrchestrator — instructions impossibles retirées', () => {
  it('n ordonne plus une passation vers un autre agent : aucun mécanisme n existe', async () => {
    // « Pour une notification ou un email, passe la main à l'agent de notification. »
    // Il n'existe NI tool NI primitive de routage accessible à l'agent : le routage
    // vit dans le handler Slack, hors de portée du modèle. Cette ligne ordonnait
    // l'impossible, invitait à NARRER une délégation qui n'a jamais lieu, et était
    // repayée à chaque aller-retour.
    const instructions = await instructionsOf(makeOnboardingOrchestrator as never);

    expect(instructions).not.toMatch(/passe la main/i);
    expect(instructions).not.toMatch(/agent de notification/i);
  });

  it('garde le refus explicite de créer un employé — le seul refus correct de la campagne', async () => {
    const instructions = await instructionsOf(makeOnboardingOrchestrator as never);

    expect(instructions).toMatch(/CRÉATION D'EMPLOYÉ/);
    expect(instructions).toMatch(/tu ne peux PAS créer d'employé/);
    // Le chemin de remplacement est RÉEL (handler `team_join` → DM « Compléter mon
    // profil » → modale → workflow). Il reste cité, mais il est désormais rattaché à
    // sa condition de déclenchement : la personne doit rejoindre Slack.
    expect(instructions).toMatch(/Compléter mon profil/);
    expect(instructions).toMatch(/rejoint Slack/i);
  });
});
