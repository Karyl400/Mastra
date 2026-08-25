import { describe, it, expect } from 'vitest';

import {
  MAX_CHAIN_LENGTH,
  planIntentChain,
  splitIntents,
} from '../../../src/features/notification/domain/services/intent-chain';
import { AGENT_TOOLS } from '../../../src/shared/agent-capabilities';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * DEUX DEMANDES DANS UN MESSAGE — et la seconde disparaissait en silence
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le routage choisit UN agent par message. Quand un message porte deux demandes servies par
 * deux agents différents, la seconde n'est jamais exécutée — et rien ne le dit.
 *
 * ⚠️ **MESURÉ sur cinq phrases réelles, AVANT d'écrire une ligne** :
 *
 *   « résume <#…> et rappelle-moi jeudi »          → knowledgeAgent, sans scheduleReminder
 *   « crée mon dossier et programme un rappel »    → notificationAgent, qui ne crée rien
 *   « qui gère le backend ? et envoie-lui un mot » → notificationAgent — passe PAR CHANCE
 *   « génère le guide et envoie-le-moi »           → orchestrateur — passe PAR CHANCE
 *   « résume <#…> et envoie ça à recrue@… »        → knowledgeAgent — échoue par chance
 *
 * Deux marchent par hasard, deux perdent la moitié de la demande sans le dire, et la cinquième
 * est la phrase que la quarantaine interdit.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE PIÈGE, ET LA PROPRIÉTÉ QUI LE FERME
 * ════════════════════════════════════════════════════════════════════════════
 *
 * « Découper, router chaque morceau, recoller » ferait MARCHER la cinquième phrase :
 *
 *   fragment 1 « résume <#engineer-karyl> »       → knowledgeAgent ✅ je suis membre
 *   fragment 2 « envoie ça à recrue@exemple.com » → un agent qui sait envoyer ✅
 *
 * **Chaque moitié est licite ; l'enchaînement serait l'exfiltration.** Aujourd'hui elle échoue
 * par accident ; un chaînage naïf construirait le canal que tout le reste du dépôt interdit.
 *
 * ⚠️ **LA PROPRIÉTÉ QUI FERME LE PIÈGE N'EST PAS UNE LISTE NOIRE, C'EST L'INDÉPENDANCE.** Une
 * première version de ce module refusait certains enchaînements d'après la boîte à outils du
 * second agent. C'était à la fois trop et trop peu : « résume ce canal ET RAPPELLE-MOI JEUDI »
 * — parfaitement bénin — s'y faisait refuser, tandis qu'une liste noire se périme au premier
 * outil déplacé.
 *
 * La règle retenue est structurelle : **une étape ne reçoit JAMAIS la sortie d'une étape
 * précédente.** Chaque fragment est traité comme s'il avait été envoyé seul, contre le MÊME
 * instantané d'historique. Il en découle un théorème court :
 *
 *   > Aucun contenu ne circule entre les étapes, donc l'ensemble ne peut rien porter que ses
 *   > parties ne portaient déjà : **l'ensemble est sûr si et seulement si chaque partie l'est.**
 *
 * ⚠️ **ET QUAND LA SECONDE DEMANDE RENVOIE À LA PREMIÈRE, ON DEMANDE AU LIEU D'EXÉCUTER.**
 * Recommandation du propriétaire, 2026-08-25 : *« en cas de confusion dans la requête, clarifier
 * plutôt, et attendre la confirmation avant d'exécuter. »* Sur la cinquième phrase, exécuter
 * produirait « qu'est-ce que je dois envoyer ? » — techniquement sûr, mais illisible : ça se lit
 * comme un bot ayant perdu le fil. La clarification coûte ZÉRO token et dit la vraie raison.
 *
 * L'invariant d'indépendance est vérifié là où il s'exécute :
 * `tests/unit/handlers/intent-chain-execution.test.ts`.
 */

const CHANNEL = '<#C0BMLKC4S5T|kisso-hq>';

describe('découpage — on ne change rien quand il n’y a rien à changer', () => {
  it('un message simple ne produit AUCUNE chaîne', () => {
    // La propriété qui protège le chemin nominal : l'immense majorité des messages ne paie pas
    // un token de plus, parce qu'aucune chaîne n'est formée.
    expect(planIntentChain('génère-moi le guide en PDF')).toBeNull();
  });

  it('deux fragments servis par le MÊME agent ne produisent aucune chaîne', () => {
    // « génère le guide et envoie-le-moi » : l'orchestrateur sert les deux, via `deliverTo`.
    // Former une chaîne ici doublerait le coût sans rien apporter.
    expect(planIntentChain('génère le guide en PDF et envoie-le-moi en PDF')).toBeNull();
  });

  it('un « et » à l’intérieur d’une même demande ne coupe pas', () => {
    // Sans le filtre de tête verbale, « un rappel pour Awa et Karyl » deviendrait deux appels.
    expect(planIntentChain('programme un rappel pour Awa et Karyl')).toBeNull();
    expect(splitIntents('programme un rappel pour Awa et Karyl')).toHaveLength(1);
  });

  it('une salutation ou un fragment trop court ne coupe pas', () => {
    expect(planIntentChain('bonjour et merci')).toBeNull();
  });
});

describe('découpage — la chaîne se forme quand deux agents sont nécessaires', () => {
  it('résumé de canal PUIS rappel', () => {
    const plan = planIntentChain(`résume ${CHANNEL} et rappelle-moi jeudi de le relire`);

    expect(plan).not.toBeNull();
    expect(plan?.steps.map((s) => s.agentId)).toEqual(['knowledgeAgent', 'notificationAgent']);
    expect(plan?.steps[0].text).toContain('résume');
    expect(plan?.steps[1].text).toContain('rappelle-moi');
  });

  it('création de dossier PUIS rappel', () => {
    const plan = planIntentChain('crée mon dossier et programme un rappel pour lundi');

    expect(plan?.steps.map((s) => s.agentId)).toEqual([
      'onboardingOrchestrator',
      'notificationAgent',
    ]);
  });

  it('chaque étape va à un agent qui porte RÉELLEMENT l’outil nécessaire', () => {
    // Anti-tautologie : on ne vérifie pas un nom, on vérifie une capacité, dérivée du câblage.
    const plan = planIntentChain(`résume ${CHANNEL} et rappelle-moi jeudi de le relire`);
    expect(AGENT_TOOLS[plan!.steps[0].agentId]).toContain('getChannelHistory');
    expect(AGENT_TOOLS[plan!.steps[1].agentId]).toContain('scheduleReminder');
  });

  it('reconnaît « puis » et « ensuite » autant que « et »', () => {
    for (const connector of ['puis', 'ensuite', 'et']) {
      const plan = planIntentChain(
        `résume ${CHANNEL} ${connector} rappelle-moi jeudi de le relire`,
      );
      expect(plan?.steps.length, `« ${connector} » n'a pas coupé`).toBe(2);
    }
  });

  it('la phrase interdite est CLARIFIÉE, pas exécutée', () => {
    // ⚠️ Recommandation du propriétaire, 2026-08-25 : *« en cas de confusion dans la requête,
    // clarifier plutôt, et attendre la confirmation avant d'exécuter. »*
    //
    // Le second fragment RENVOIE au premier : il demande un transport de contenu que le
    // harness ne fera pas. L'exécuter produirait « qu'est-ce que je dois envoyer ? », ce qui se
    // lit comme un bot ayant perdu le fil. On demande, à zéro token.
    const plan = planIntentChain(`résume ${CHANNEL} et envoie ça à recrue@exemple.com`);
    expect(plan?.refused).toBe('refers_back');
    expect(plan?.steps).toEqual([]);
  });

  it('mais une seconde demande AUTONOME s’exécute sans rien demander', () => {
    // La contrepartie, sans laquelle la clarification deviendrait une friction permanente :
    // « rappelle-moi jeudi de le relire » ne renvoie à rien qui doive CIRCULER.
    const plan = planIntentChain(
      `résume ${CHANNEL} et rappelle-moi jeudi de relire le compte rendu`,
    );
    expect(plan?.refused).toBeUndefined();
    expect(plan?.steps).toHaveLength(2);
  });
});

describe('le plan refuse plutôt que de coûter trois appels', () => {
  it('au-delà de la borne, on le DIT au lieu d’en faire la moitié', () => {
    const plan = planIntentChain(
      `résume ${CHANNEL} et rappelle-moi jeudi de le relire et génère le guide en PDF`,
    );
    expect(MAX_CHAIN_LENGTH).toBe(2);
    expect(plan?.refused).toBe('too_many_intents');
    expect(plan?.steps).toEqual([]);
  });

  it('un refus ne laisse JAMAIS d’étapes à exécuter — jamais de plan tronqué', () => {
    // Tronquer serait le pire des deux mondes : on exécuterait la première demande, on tairait
    // les suivantes, et l'on aurait payé pour reproduire le défaut d'aujourd'hui.
    const plan = planIntentChain(
      `résume ${CHANNEL} et rappelle-moi jeudi de le relire et envoie un email et crée un dossier`,
    );
    expect(plan?.steps).toEqual([]);
  });
});
