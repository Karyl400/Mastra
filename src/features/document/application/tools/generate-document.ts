import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import type { DocumentRepository } from '../../domain/ports/document.repository';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import type {
  DocumentRenderInput,
  DocumentRenderer,
  RenderedDocument,
} from '../../domain/ports/document-renderer';
// Ports d'une AUTRE feature, importés depuis sa couche `domain`.
//
// C'est la règle de dépendance, pas une entorse : `application` peut dépendre d'un
// `domain`, y compris celui d'une feature voisine — précédent en place dans
// `employee/application/tools/get-employee-profile.ts`, qui lit le port
// `onboarding/domain/ports/onboarding.repository`. Redéclarer ici un troisième
// `EmailProvider` (le dépôt en duplique déjà un pour `EmployeeRepository`) ferait
// diverger la borne de taille des pièces jointes et la forme des uploads entre deux
// features qui parlent au MÊME adaptateur.
import type {
  EmailProvider,
  FileUploadProvider,
} from '../../../notification/domain/ports/providers';
import { createDocument } from '../../domain/entities/document';
import { DEFAULT_TITLES } from '../../domain/services/document-template';
import { uuidSchema } from '../../../../shared/validation';
import { fullName } from '../../../../shared/name-matching';
import {
  sanitizeDocumentSource,
  sanitizeDocumentText,
} from '../../../../shared/security/agent-output';
import { logger } from '../../../../shared/logger';
import { readSlackContext, canReadPersonRecord } from '../../../../shared/slack-request-context';
import type { OnboardingInterviewRepository } from '../../../onboarding/domain/ports/onboarding-interview.repository';
import { buildRunKey, makeRunGuard } from '../../../../shared/tool-idempotency';
import { DocumentFormat, DocumentStatus, DocumentType } from '../../../../shared/types';
import { errorMessage } from '../../../../shared/errors';

/**
 * Génération de document — outil exposé au LLM.
 *
 * ## Ce que l'outil fait, et pourquoi il le fait maintenant
 *
 * Avant le 2026-08-11 il se réduisait à un `repo.save()` : aucun fichier n'était
 * produit, aucune livraison n'existait. C'est ce vide qui a fabriqué en production le
 * faux lien `https://kisso.internal/docs/<uuid>/download` — sommé de livrer un
 * document, le modèle en a inventé la seule chose qu'il savait produire, une URL.
 * L'outil RENVOIE désormais un fichier réel : il le rend (PDF ou DOCX), l'enregistre,
 * le livre, et rend compte de la livraison.
 *
 * ## Comment la destination est exprimée — arbitrage
 *
 * Un SEUL champ énuméré, `deliverTo`. Le plafond Groq (12 000 tokens/minute) interdit
 * d'ajouter un tool, et chaque champ d'`inputSchema` est réémis à CHAQUE aller-retour :
 * trois champs (canal, thread, adresse) coûteraient plus que la capacité ne rapporte.
 *
 * Surtout, ces trois champs n'ont RIEN à faire dans le schéma : le serveur les connaît
 * déjà mieux que le modèle.
 * - Le canal et le thread viennent du `requestContext` (`readSlackContext`) : le modèle
 *   ne voit jamais un identifiant de canal, il ne peut donc ni l'inventer ni le détourner.
 * - L'adresse email est résolue depuis l'annuaire à partir d'`employeeId`. C'est
 *   exactement le modèle de menace déjà appliqué par `send-notification.ts` : cet outil
 *   est atteignable depuis un message Slack arbitraire, donc toute valeur produite par le
 *   LLM est réputée contrôlée par un attaquant. **Une adresse fournie par le modèle ne
 *   serait jamais utilisée.**
 *
 * Il reste au modèle le seul choix qui soit réellement le sien : où l'utilisateur veut
 * recevoir le document. `slack` par défaut — la demande arrive d'une conversation Slack
 * dans la quasi-totalité des cas, et un défaut qui oblige à demander « où veux-tu que je
 * l'envoie ? » coûte un aller-retour complet, soit plus cher que le champ lui-même.
 *
 * ## Régime d'erreur
 *
 * Le document est TOUJOURS enregistré, même quand la livraison échoue. L'échec est
 * retourné explicitement au modèle (`delivery` + `reason` + `hint`) et journalisé en
 * `error` — jamais avalé. C'est la contrepartie du piège déjà documenté dans le dépôt
 * (`emailSent: false` sous `status: 'success'`) : dégrader sans le dire est pire que
 * d'échouer.
 *
 * ## Assainissement du contenu
 *
 * `title` et `content` sont écrits INTÉGRALEMENT par le modèle et ne passaient par
 * aucun filtre : `sanitizeAgentOutput` n'a qu'un site d'appel, `response.text` dans le
 * handler Slack, et les arguments de tool n'y passent jamais. Des PDF réellement produits
 * imprimaient donc `kisso_<32 hex>`, `[SECURITY_BLOCK]`, `DIRECTIVE 3.1` et
 * `https://kisso.internal/…` en clair, sans le moindre log — un canal d'exfiltration
 * téléchargeable et repartageable, contournant le filet unique.
 *
 * Le filtre est posé À DEUX endroits, et ce n'est pas une redondance :
 *   - au seuil du RENDU (`buildDocumentOutline`, couche domain), seul point que ni un
 *     renderer ni `documentGenerationWorkflow` ne peuvent contourner ;
 *   - ICI, parce que la PERSISTANCE (`documentRepo.save`) et la JOURNALISATION vivent en
 *     dehors du renderer. Un document enregistré avec un marqueur en base serait ressorti
 *     tel quel au premier code qui le relirait.
 * L'opération est idempotente, la double application est donc sans effet de bord.
 */

/** Verdict de livraison rendu au modèle. C'est LUI qui doit gouverner la réponse. */
type DeliveryVerdict = 'slack' | 'email' | 'none' | 'failed';

/**
 * Consignes rendues au modèle dans les cas dégradés UNIQUEMENT.
 *
 * Elles ne sont pas payées dans le cas nominal : pas un caractère de plus dans le
 * contexte quand la livraison réussit (même arbitrage que `onboardingHint` dans
 * `get-employee-profile.ts`). Chacune dit au modèle ce qu'il doit ANNONCER, faute de
 * quoi il comble le vide — c'est la mécanique exacte du faux lien de téléchargement.
 */
const HINTS = {
  employee_not_found:
    "Aucun employé ne porte cet identifiant : rien n'a été généré. Ne l'invente pas, demande " +
    "l'email professionnel et passe par findEmployeeByEmail.",
  no_slack_context:
    "Aucun canal Slack connu ici : le document est enregistré mais n'a été envoyé nulle part. " +
    'Dis-le, ne promets aucun envoi.',
  missing_scope:
    "Le bot n'a pas le droit d'envoyer des fichiers dans Slack : document enregistré, non livré. " +
    'Dis-le simplement, sans lien ni pièce jointe promise.',
  no_email:
    'Aucune adresse email connue pour cet employé : document enregistré, non envoyé. Dis-le.',
  delivery_failed:
    "L'envoi a échoué : le document est prêt et enregistré, mais non livré. Dis-le, et ne " +
    'propose aucun lien de téléchargement.',
  not_rendered:
    "Aucun fichier n'a pu être produit : seul le texte est enregistré. Dis que le document " +
    "existe mais qu'aucun fichier n'a été envoyé.",
  not_authorized:
    "Tu n'as pas le droit de produire un document au nom de cette personne. Dis-le simplement, " +
    'sans inventer de motif. Ne réessaie pas avec un autre outil et ne reformule pas la demande.',
} as const;

type HintKey = keyof typeof HINTS;

/**
 * Reconnaît le refus `missing_scope` de Slack À TRAVERS l'enrobage de l'adaptateur.
 *
 * `SlackAdapter.uploadFile` retraduit ce cas en une `Error` de prose qui nomme les deux
 * gestes humains requis (ajouter `files:write`, PUIS réinstaller l'app) et conserve
 * l'erreur d'origine dans `cause`. On inspecte donc la CHAÎNE de causes et non le seul
 * objet reçu : lire `err.data.error` à plat, comme le fait l'adaptateur, ne verrait
 * jamais rien ici.
 *
 * Le repli sur le message est volontaire : c'est le seul filet si l'adaptateur cesse un
 * jour de propager `cause`, et se tromper coûte seulement un `hint` moins précis.
 */
function isMissingScope(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth++) {
    const data = (current as { data?: { error?: unknown } }).data;
    if (typeof data?.error === 'string' && data.error === 'missing_scope') return true;

    const message = current instanceof Error ? current.message : '';
    if (message.includes('missing_scope') || message.includes('files:write')) return true;

    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface GenerateDocumentDeps {
  documentRepo: DocumentRepository;
  /** Annuaire : alimente le gabarit ET résout l'adresse de livraison. */
  employeeRepo: EmployeeRepository;
  /**
   * Un renderer par format. Une LISTE et non une map : c'est le renderer qui déclare
   * son format (`DocumentRenderer.format`), donc le câblage ne peut pas se tromper de
   * clé — une map laisserait passer `{ pdf: new DocxService() }`.
   */
  renderers: readonly DocumentRenderer[];
  /** Absent en test ou hors Slack : la livraison dégrade au lieu d'échouer. */
  fileUpload?: FileUploadProvider;
  emailProvider?: EmailProvider;
  /**
   * Entretien post-profil, résolu CÔTÉ SERVEUR pour nourrir le gabarit.
   *
   * OPTIONNEL à dessein : sans lui, le document est exactement celui d'avant. C'est ce qui
   * rend ce câblage sûr à ajouter — un guide reste produit même sur une base où la table
   * `onboarding_interview` n'a pas encore été appliquée.
   */
  interviewRepo?: OnboardingInterviewRepository;
  /** Résout un nom lisible depuis un identifiant `C…`. Sans lui, les canaux ne sont pas cités. */
  channelRepo?: { listChannels(): Promise<ReadonlyArray<{ channelId: string; name: string }>> };
}

/**
 * Formats réellement RENDUS, et donc les seuls exposés au modèle.
 *
 * `DocumentFormat` en compte dix (`markdown`, `html`, `json`, `csv`, `xlsx`, `pptx`,
 * `image`, `txt`…) mais deux seulement ont un renderer. Les annoncer tous aurait deux
 * défauts, chacun suffisant :
 *   1. le schéma promettrait au modèle ce que le code ne sait pas faire — c'est la
 *      définition même du piège que ce lot corrige ;
 *   2. huit valeurs mortes sont réémises à chaque aller-retour, sous plafond Groq.
 * `z.enum` sérialise en `{"type":"string","enum":[…]}` — plat, donc accepté par le
 * validateur de tool-calls (voir `tests/unit/tools/tool-schema-flatness.test.ts`).
 *
 * `execute` reste néanmoins tolérant à un format hors liste : l'outil est aussi
 * appelable hors Zod (appel direct, workflow, test), et un `throw` y serait un piège.
 */
const RENDERABLE_FORMATS = [DocumentFormat.Pdf, DocumentFormat.Docx] as const;

/**
 * Ce que la personne a dit d'elle à l'entretien, prêt pour le gabarit.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Côté SERVEUR, jamais par le modèle — et ne LÈVE jamais
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Même chemin que la fiche employé : l'entretien est résolu à partir de l'`employeeId`, sans
 * qu'aucune de ces valeurs ne traverse la fenêtre du modèle. C'est ce qui rend un guide
 * personnel pour **zéro token**, là où le gabarit imprimait auparavant quatre puces écrites
 * en dur, identiques pour tout le monde.
 *
 * ⚠️ Toute indisponibilité est AVALÉE et rend `undefined`. Un guide sans section « ton
 * quotidien » reste un guide ; un guide qui n'existe pas parce que la table
 * `onboarding_interview` n'a pas encore été appliquée serait une régression franche. Même
 * contrat de dégradation que la mémoire conversationnelle.
 *
 * Les NOMS de canaux sont résolus ici parce que la base stocke des `C…` — qui ne se lisent
 * pas — et qu'un canal se renomme sans que son identifiant bouge. Un identifiant non résolu
 * est ÉCARTÉ plutôt qu'imprimé brut : « #C0BP3RCLLA1 » dans un document d'accueil est pire
 * qu'une ligne en moins.
 */
async function readInterview(
  interviewRepo: OnboardingInterviewRepository | undefined,
  channelRepo:
    { listChannels(): Promise<ReadonlyArray<{ channelId: string; name: string }>> } | undefined,
  employeeId: string,
): Promise<DocumentRenderInput['interview']> {
  if (!interviewRepo) return undefined;

  try {
    const interview = await interviewRepo.findByEmployee(employeeId);
    if (!interview) return undefined;

    let channels: string[] = [];
    if (channelRepo && interview.channels.length > 0) {
      const nameOf = new Map(
        (await channelRepo.listChannels()).map((channel) => [channel.channelId, channel.name]),
      );
      channels = interview.channels
        .map((channelId) => nameOf.get(channelId))
        .filter((name): name is string => Boolean(name && name.length > 0));
    }

    return { dailyWork: interview.dailyWork, workStyle: interview.workStyle, channels };
  } catch (error) {
    logger.warn('Entretien indisponible — document produit sans sa matière personnelle', {
      error: errorMessage(error),
    });
    return undefined;
  }
}

export function makeGenerateDocument(deps: GenerateDocumentDeps) {
  const {
    documentRepo,
    employeeRepo,
    renderers,
    fileUpload,
    emailProvider,
    interviewRepo,
    channelRepo,
  } = deps;

  /**
   * Une garde par INSTANCE de tool, et non par module.
   *
   * En production cela ne change rien : `makeGenerateDocument` n'est appelée qu'une fois,
   * au câblage de `src/mastra/index.ts`, donc la garde vit aussi longtemps que le
   * processus — exactement la portée voulue. En test, en revanche, une garde de module
   * rendait les cas dépendants de leur ordre d'exécution : le deuxième test qui demandait
   * le même document retombait sur le résultat mémorisé par le premier. La portée utile
   * est assurée par la clé (conversation) et le TTL, jamais par la durée de vie de l'objet.
   */
  const runGuard = makeRunGuard();

  return createTool({
    id: 'generateDocument',
    description: 'Génère un document (guide, contrat, lettre…) et le livre dans Slack ou par email',
    // Schéma dépouillé pour le budget de tokens (voir `schedule-reminder.ts`) :
    // les `.describe()` qui ne faisaient que répéter le nom du champ ont été retirés.
    inputSchema: z.object({
      employeeId: uuidSchema.describe('UUID annuaire'),
      type: z.nativeEnum(DocumentType),
      title: z.string().min(1).max(200).describe('rédige-le, ne le demande pas'),
      // ⚠️ Borne HAUTE ajoutée le 2026-08-13. `title`/`subject` étaient bornés à 200 sur la
      // ligne voisine, ce champ ne l'était pas — asymétrie relevée par l'audit, et c'est le
      // champ VOLUMINEUX. Rien en aval ne tronque : ni les assainisseurs de document ni les
      // adaptateurs d'envoi. Un contenu non borné est persisté, relu, et repart dans la
      // fenêtre du modèle, sur un système dont la contrainte dominante EST le budget de
      // tokens.
      // ⚠️ LA DÉROGATION DE RÉDACTION, et elle a mis sept jours à arriver ici.
      //
      // Le bilan de la série C (2026-08-11 : 7 messages, 0 email, 0 rappel, 0 document) a
      // établi que les outils POSAIENT les questions au lieu de faire le travail, et que le
      // correctif devait vivre dans le `.describe()` du champ — PAR CHAMP, jamais dans le
      // prompt, où il contredirait frontalement `AGENT_ANTI_INVENTION_BLOCK` (« n'invente
      // jamais une donnée absente : demande-la ») et reviendrait à tirer à pile ou face à
      // chaque tour. La ligne de partage : un email ou un UUID se RETROUVENT, une prose se
      // PRODUIT.
      //
      // `sendNotification.body` l'a reçue le jour même. Ces deux champs-ci, non — et la
      // doctrine de l'époque citait `generateDocument` comme « le seul outil de la campagne
      // qui ait abouti », donc le modèle à copier : c'est cette formulation qui a masqué
      // l'oubli pendant sept jours.
      //
      // Constaté en production le 2026-08-18 sur « Génère-moi le guide d'accueil en PDF » :
      // « Quel texte doit contenir le guide d'accueil ? Fournis-moi le contenu… ». Un
      // aller-retour entier perdu — poste de coût DOMINANT, ≈ 1 500 tokens sur un budget
      // journalier de 100 000 — pour un produit qui demandait à un arrivant de rédiger
      // lui-même son guide d'accueil.
      //
      // ⚠️ Ne PAS l'étendre à `employeeId` : un identifiant se retrouve. L'y poser
      // inviterait à en inventer un, ce qui est exactement le bug de destinataire du
      // 2026-08-14 — dix documents enregistrés sous le mauvais UUID.
      content: z.string().min(1).max(20000).describe('rédige-le, ne le demande pas'),
      // `pdf` par défaut, et non plus `txt`. L'attente produit est un PDF ; un défaut
      // `txt` obligeait le modèle à deviner qu'il fallait demander autre chose, et
      // produisait donc des documents que personne n'avait demandés dans ce format.
      format: z.enum(RENDERABLE_FORMATS).optional().default(DocumentFormat.Pdf),
      // Destination — un seul champ, valeurs auto-explicites, aucun `.describe()`.
      // Ni canal, ni thread, ni adresse : voir le modèle de menace en tête de fichier.
      deliverTo: z.enum(['slack', 'email', 'none']).optional().default('slack'),
    }),
    execute: async (data, ctx) => {
      // ---------------------------------------------------------------------
      // Assainissement — AVANT tout usage du titre et du corps
      // ---------------------------------------------------------------------
      //
      // Le titre est une feuille : rien à y traduire, on l'assainit à fond. Le corps
      // conserve son balisage markdown, que `buildDocumentOutline` traduit ensuite en
      // titres, puces et paragraphes ; le retirer ici aplatirait le document.
      const { title, content } = sanitizeDocumentInput({
        title: data.title,
        content: data.content,
        type: data.type,
        employeeId: data.employeeId,
      });

      logger.info('Génération document', {
        employeeId: data.employeeId,
        type: data.type,
        title,
        format: data.format,
        deliverTo: data.deliverTo,
      });

      // ---------------------------------------------------------------------
      // Garde d'idempotence — un livrable par CONVERSATION, pas seulement par run
      // ---------------------------------------------------------------------
      //
      // Deux incidents distincts, même correctif.
      //
      // (1) 2026-08-12 19:42 UTC — un SEUL message Slack, et
      //     `toolCalls: ["generateDocument","findEmployeeByEmail","getEmployeeProfile",
      //     "generateDocument"]` : le modèle a régénéré après avoir « vérifié » l'employé.
      //
      // (2) 2026-08-12 21:58–22:05 UTC — rejeu d'une conversation réelle : **7 documents
      //     et 3 emails identiques en 8 minutes**. À « As-tu envoyé le rapport ? », le
      //     modèle a REGÉNÉRÉ le guide au lieu de constater qu'il venait de l'envoyer,
      //     puis encore, puis encore. Cause de fond : le système ne sait que CRÉER — il
      //     n'existe aucun outil de relecture de document, donc refaire est la seule
      //     action que le modèle puisse entreprendre quand on lui demande « où en est-ce ? ».
      //
      // La clé porte donc la CONVERSATION (`channel[:threadTs]`) et non le message : le
      // cas (2) s'étale sur plusieurs messages. Le TTL fait le reste — redemander le même
      // document, au même format, vers la même destination, dans les 10 minutes, n'est
      // jamais intentionnel ; au-delà, c'est une demande neuve et elle passe.
      //
      // La clé ignore délibérément `content` : les deux appels de l'incident (1) avaient
      // un contenu DIFFÉRENT (15 puis 249 caractères), donc hacher les arguments complets
      // n'aurait rien attrapé. C'est l'identité du LIVRABLE qui compte. Elle inclut en
      // revanche `deliverTo` : « et envoie-le par email » après une livraison Slack est
      // une demande légitimement différente.
      //
      // ⚠️ Garde EN MÉMOIRE, donc par instance. Sur deux instances distinctes, le doublon
      // repasse — on retombe alors exactement sur le comportement d'avant, jamais pire.
      // Un store partagé coûterait une E/S Turso (Tokyo) sur un chemin déjà tendu côté ACK.
      const slackCtx = readSlackContext(ctx?.requestContext);
      const { effectiveDeliverTo, dedupKey } = resolveDeliveryIntent({
        slackCtx,
        deliverTo: data.deliverTo,
        employeeId: data.employeeId,
        type: data.type,
        format: data.format,
        title,
      });

      const previous = dedupKey
        ? runGuard.get<{ result: Record<string, unknown>; eventTs?: string }>(dedupKey)
        : undefined;

      if (previous) {
        // Les deux incidents ne se diagnostiquent pas pareil : un second appel dans le
        // MÊME message est un défaut de raisonnement du modèle, un second appel dans un
        // message SUIVANT est l'utilisateur qui redemande faute d'avoir vu le fichier.
        const sameRun = Boolean(slackCtx?.eventTs) && previous.eventTs === slackCtx?.eventTs;
        logger.warn(
          sameRun
            ? 'Document déjà produit dans ce run — second appel ignoré'
            : 'Document déjà livré dans cette conversation — régénération évitée',
          { employeeId: data.employeeId, type: data.type, deliverTo: effectiveDeliverTo },
        );

        // On rend le résultat du PREMIER appel, augmenté du fait qu'il n'y a rien à
        // refaire. Sans cette mention, le modèle reste devant un résultat identique au
        // précédent et peut conclure que son appel n'a pas abouti — c'est précisément
        // l'absence de « l'effet existe déjà » qui a produit les doublons.
        return {
          ...previous.result,
          alreadyDelivered: true as const,
          hint:
            "Ce document a DÉJÀ été produit et livré dans cette conversation ; rien n'a été " +
            "refait. Dis-le et renvoie la personne vers l'envoi précédent — ne prétends pas " +
            "l'avoir regénéré.",
        };
      }

      // ---------------------------------------------------------------------
      // Résolution de l'employé — le gabarit ET l'adresse en dépendent
      // ---------------------------------------------------------------------
      //
      // Un identifiant inconnu ne produit PAS d'exception : l'AI SDK v7 réinjecte au
      // modèle ce qu'un tool lève, et face à un vide le modèle comble (c'est l'origine
      // de l'over-promise « veux-tu que je crée le profil ? »). Un résultat qui
      // INSTRUIT vaut mieux — même choix que `get-employee-profile.ts`.
      //
      // Rien n'est enregistré dans ce cas : `documents.employee_id` porte une clé
      // étrangère vers `employees`, une ligne orpheline serait refusée par la base.
      // ══════════════════════════════════════════════════════════════════════
      // FRONTIÈRE D'AUTORISATION — le contournement le plus large des quatre
      // ══════════════════════════════════════════════════════════════════════
      //
      // Relevé par la revue adversariale du 2026-08-13, APRÈS que les trois lectures RH
      // (`getEmployeeProfile`, `getTaskList`, `getNotificationHistory`) eurent été fermées.
      // Ce tool restituait exactement le même dossier par un chemin voisin, et en pire :
      //
      //  1. il accepte un `employeeId` ARBITRAIRE, produit par le modèle donc par le texte ;
      //  2. il imprime `firstName`, `lastName`, `email`, `department`, `position` et
      //     `startDate` de cette personne dans le document rendu (voir `renderer.render`) ;
      //  3. il livre le fichier dans le canal du DEMANDEUR (`slackCtx.channel`), pas dans
      //     celui de la personne concernée.
      //
      // Soit, en deux messages : « retrouve le profil de collegue@… » puis « génère-lui une
      // lettre de bienvenue » — et l'attaquant reçoit en DM un PDF TÉLÉCHARGEABLE ET
      // REPARTAGEABLE portant le dossier d'un collègue. Fermer les trois lectures en laissant
      // celle-ci ouverte n'aurait fermé qu'une porte sur deux, et pas la plus large.
      //
      // ⚠️ AVANT la résolution de l'employé, comme dans les trois autres : un refus qui lit
      // d'abord et filtre ensuite fuite par sa latence et journalise une consultation qui
      // n'aurait pas dû avoir lieu.
      //
      // Générer un document POUR QUELQU'UN D'AUTRE reste légitime — c'est le cas d'usage
      // central du produit, une lettre de bienvenue est écrite par les RH. C'est exactement
      // pourquoi la règle est celle des trois autres et non un refus sec : soi-même toujours,
      // autrui au niveau `full`.
      if (!canReadPersonRecord(ctx?.requestContext, data.employeeId)) {
        logger.warn('Document refusé — demandeur non autorisé pour cette personne', {
          employeeId: data.employeeId,
        });
        return {
          saved: false as const,
          delivery: 'none' as DeliveryVerdict,
          reason: 'not_authorized',
          hint: HINTS.not_authorized,
        };
      }

      const employee = await employeeRepo.findById(data.employeeId);
      if (!employee) {
        logger.warn('Document refusé — aucun employé pour cet identifiant', {
          employeeId: data.employeeId,
        });
        return {
          saved: false as const,
          delivery: 'none' as DeliveryVerdict,
          reason: 'employee_not_found',
          hint: HINTS.employee_not_found,
        };
      }

      // ─────────────────────────────────────────────────────────────────────
      // TRACE — un document produit POUR AUTRUI
      // ─────────────────────────────────────────────────────────────────────
      //
      // Aucun refus : un manager ou une RH qui produit la lettre de bienvenue d'un
      // arrivant est le cas d'usage NORMAL — c'est même l'objet du produit. Mais c'est
      // aussi le seul cas où une erreur d'`employeeId` fait partir un fichier chez
      // quelqu'un qui n'était pas concerné, et le relevé du 2026-08-13 montre que ça
      // arrive : les DIX documents de la base portent l'UUID de Karyl, dont « Bienvenue
      // Awa », livré à l'adresse de Karyl.
      //
      // ⚠️ `warn` et non `info` : c'est la ligne à chercher la prochaine fois qu'un
      // document semble être parti au mauvais destinataire. On journalise le fait, jamais
      // l'adresse — le logger masquerait de toute façon un email.
      // `slackCtx` a déjà été lu ligne 384 : un second appel ne rendrait rien de plus.
      const requesterEmployeeId = slackCtx?.employeeId;
      if (requesterEmployeeId && requesterEmployeeId !== data.employeeId) {
        logger.warn('Document produit pour une AUTRE personne que le demandeur', {
          subjectId: data.employeeId,
          requesterId: requesterEmployeeId,
          deliverTo: effectiveDeliverTo,
        });
      }

      // ---------------------------------------------------------------------
      // Rendu
      // ---------------------------------------------------------------------
      const { rendered, producedFormat, failure } = await renderDocument({
        renderers,
        type: data.type,
        format: data.format,
        title,
        content,
        employee,
        interview: await readInterview(interviewRepo, channelRepo, data.employeeId),
      });

      // ---------------------------------------------------------------------
      // Livraison — aucune exception ne sort de ce bloc
      // ---------------------------------------------------------------------
      const delivered = await deliver({
        intent: effectiveDeliverTo,
        rendered,
        slackCtx,
        fileUpload,
        emailProvider,
        employeeEmail: employee.email,
        employeeId: data.employeeId,
        title,
        failure,
      });
      const { delivery, reason } = delivered;

      // ---------------------------------------------------------------------
      // Enregistrement — TOUJOURS, quel que soit le sort de la livraison
      // ---------------------------------------------------------------------
      const doc = createDocument({
        id: crypto.randomUUID(),
        employeeId: data.employeeId,
        type: data.type,
        // Persistance : les valeurs ASSAINIES, jamais celles du modèle. Une ligne
        // enregistrée avec un marqueur ressortirait telle quelle au premier code qui la
        // relirait — le filtre du rendu ne protège que le fichier, pas la base.
        title,
        content,
        format: producedFormat,
      });

      const now = new Date().toISOString();
      const generated = {
        ...doc,
        // `Sent` n'est pas cosmétique : c'est la seule trace persistée d'une livraison
        // réussie, la seule façon de savoir après coup si un document est parti.
        status:
          delivery === 'slack' || delivery === 'email'
            ? DocumentStatus.Sent
            : DocumentStatus.Generated,
        generatedAt: now,
        updatedAt: now,
      };

      await documentRepo.save(generated);
      logger.info('Document généré', { id: generated.id, format: producedFormat, delivery });

      // ---------------------------------------------------------------------
      // Tool-result — PROJETÉ, jamais l'entité
      // ---------------------------------------------------------------------
      //
      // L'outil retournait l'entité COMPLÈTE, `content` compris : il renvoyait au modèle
      // le texte que le modèle venait d'écrire, à ses frais, et ce texte restait ensuite
      // dans l'historique de TOUS les tours suivants. Même défaut, même correction que
      // `getEmployeeProfile` (2 506 → 329 tokens, voir `task-summary.mapper.ts`).
      //
      // Ne sort ici que ce dont le modèle a besoin pour formuler sa réponse : de quoi
      // désigner le document, le format réellement produit (il peut différer du demandé),
      // le nom du fichier livré — et surtout le VERDICT DE LIVRAISON, sans lequel il ne
      // peut pas dire la vérité. La taille ne dépend plus de la longueur du contenu.
      // ⚠️ `recipient` — ajouté le 2026-08-14 après le relevé de production.
      //
      // Les DIX documents de la Turso portent l'UUID de Karyl, y compris celui intitulé
      // « Bienvenue Awa » (`type=welcome_letter`, `status=sent`) : son email est donc parti
      // à l'adresse de Karyl. Le tool a fait exactement ce qu'on lui demandait — c'est
      // l'`employeeId` choisi par le modèle qui était faux, faute d'un résolveur par nom.
      //
      // Ce champ ne CORRIGE rien : il rend le fait VISIBLE. Le modèle voit désormais pour
      // qui il vient de produire un document et le bloc DOCUMENTS lui impose de le nommer,
      // si bien qu'une erreur de destinataire devient lisible par l'humain au tour même,
      // au lieu de rester muette jusqu'à ce qu'on interroge la base un mois plus tard.
      // La correction, elle, est en amont : `findPersonByName`.
      //
      // Le NOM, jamais l'email — pour la même raison que `findEmployeeByEmail` n'en rend
      // pas : ce tool est atteignable par n'importe quel membre du workspace. Coût ≈ 12
      // tokens, payés à chaque document produit.
      const result = {
        saved: true as const,
        documentId: generated.id,
        format: producedFormat,
        delivery,
        recipient: fullName(employee.firstName, employee.lastName),
        ...(rendered ? { filename: rendered.filename } : {}),
        ...(reason ? { reason, hint: HINTS[reason] } : {}),
      };

      // Mémorisé APRÈS le succès : un premier appel qui a échoué avant l'enregistrement
      // ne doit pas condamner une seconde tentative du modèle. `eventTs` est conservé
      // pour distinguer, au prochain appel, « le modèle a rappelé le tool dans le même
      // message » de « l'utilisateur a redemandé » — deux défauts différents à diagnostiquer.
      //
      // La livraison n'est mémorisée que si elle a ABOUTI : un envoi échoué doit pouvoir
      // être retenté, sinon la garde transformerait une panne passagère en refus définitif
      // pendant dix minutes.
      if (dedupKey && (delivery === 'slack' || delivery === 'email')) {
        runGuard.remember(dedupKey, { result, eventTs: slackCtx?.eventTs });
      }

      return result;
    },
  });
}

/**
 * Où le document doit aller, et sous quelle clé de déduplication.
 *
 * ⚠️ **`none` est NEUTRALISÉ dans une conversation Slack**, et ce n'est pas une commodité.
 * Mesuré en production le 2026-08-12 : sur « Génère un guide en PDF ET DONNE-LE MOI pour que
 * je puisse le télécharger », le modèle a choisi `deliverTo: 'none'`, puis a annoncé à
 * l'utilisateur que le document « n'est pas livré automatiquement cette fois » — la demande
 * explicite sous les yeux.
 *
 * La valeur reste dans le schéma : elle est LÉGITIME hors Slack (workflow, playground, appel
 * direct), où il n'y a personne à qui livrer. Mais dans une conversation, un document que
 * personne ne reçoit n'est jamais ce qui a été demandé — c'est une porte de sortie offerte au
 * modèle, pas une intention d'utilisateur.
 */
function resolveDeliveryIntent(params: {
  slackCtx: { channel: string; threadTs?: string } | undefined;
  deliverTo: DeliveryIntent;
  employeeId: string;
  type: DocumentType;
  format: DocumentFormat;
  title: string;
}): { effectiveDeliverTo: DeliveryIntent; dedupKey: string | undefined } {
  const { slackCtx, title } = params;
  const data = params;
  // Même clé que `deriveConversationId` : en DM `threadTs` est absent par conception,
  // donc le canal EST la conversation.
  let conversationKey: string | undefined;
  if (slackCtx) {
    conversationKey = slackCtx.threadTs
      ? `${slackCtx.channel}:${slackCtx.threadTs}`
      : slackCtx.channel;
  }

  // ---------------------------------------------------------------------
  // `none` est NEUTRALISÉ dans une conversation Slack — correctif du 2026-08-12
  // ---------------------------------------------------------------------
  //
  // Mesuré en production : sur « Génère un guide en PDF **et donne-le moi pour que je
  // puisse le télécharger** », le modèle a choisi `deliverTo: 'none'`, puis a annoncé
  // à l'utilisateur que le document « n'est pas livré automatiquement cette fois » —
  // en ayant la demande explicite sous les yeux.
  //
  // La valeur n'est pas retirée du schéma : elle est LÉGITIME hors Slack (workflow,
  // playground, appel direct), où il n'y a personne à qui livrer. Mais à l'intérieur
  // d'une conversation Slack, un document que personne ne reçoit n'est jamais ce qui
  // a été demandé — c'est une porte de sortie offerte au modèle, pas une intention
  // d'utilisateur. On livre donc dans le fil d'où vient la demande.
  const effectiveDeliverTo =
    data.deliverTo === 'none' && slackCtx ? ('slack' as const) : data.deliverTo;

  if (effectiveDeliverTo !== data.deliverTo) {
    logger.info('deliverTo=none ignoré dans une conversation Slack — livraison dans le fil', {
      employeeId: data.employeeId,
      type: data.type,
    });
  }

  // Hors Slack, `buildRunKey` rend `undefined` et la garde est INACTIVE : le
  // playground, les workflows et les tests ne sont bornés par aucune conversation.
  const dedupKey = buildRunKey(conversationKey, 'generateDocument', [
    data.employeeId,
    data.type,
    title,
    data.format,
    effectiveDeliverTo,
  ]);

  return { effectiveDeliverTo, dedupKey };
}

/**
 * Assainit le titre et le corps AVANT tout usage, et journalise ce qui a été retiré.
 *
 * ⚠️ Le titre est une feuille : rien à y traduire, on l'assainit à fond. Le corps CONSERVE
 * son balisage markdown, que `buildDocumentOutline` traduit ensuite en titres, puces et
 * paragraphes — le retirer ici aplatirait le document.
 *
 * ⚠️ Les deux `logger.error` restent DANS cette fonction, sur le chemin nominal : ce sont les
 * seules détections d'exfiltration par document du dépôt. Un marqueur interne dans un
 * livrable téléchargeable signifie que le modèle a écrit son propre garde-fou dans un fichier
 * qui sort de l'entreprise ; il n'existait aucune ligne pour le voir avant le 2026-08-11.
 */
function sanitizeDocumentInput(input: {
  title: string;
  content: string;
  type: DocumentType;
  employeeId: string;
}): { title: string; content: string } {
  const data = input;
  const safeTitle = sanitizeDocumentText(data.title);
  const safeContent = sanitizeDocumentSource(data.content);

  const markers = [...new Set([...safeTitle.redacted, ...safeContent.redacted])];
  const hosts = [...new Set([...safeTitle.strippedUrls, ...safeContent.strippedUrls])];

  if (markers.length > 0) {
    // `error`, comme dans le handler Slack : un marqueur interne dans un DOCUMENT
    // signifie que le modèle a écrit son propre garde-fou dans un livrable
    // téléchargeable. C'est la ligne qui manquait pour détecter une exfiltration
    // par document — il n'en existait aucune.
    logger.error('Document content carried internal markers — markers removed', {
      employeeId: data.employeeId,
      type: data.type,
      markers,
    });
  }

  if (hosts.length > 0) {
    // Seuls les HÔTES : le chemin d'un lien fabriqué embarque un identifiant réel
    // (celui du 2026-08-11 portait le vrai `Document.id`).
    logger.error('Document content carried fabricated links — links removed', {
      employeeId: data.employeeId,
      type: data.type,
      hosts,
    });
  }

  // Le titre assaini peut être VIDE (un titre qui n'était qu'un emoji, ou qu'un lien
  // fabriqué). On retombe alors sur le titre par défaut du type — le même que celui
  // que le gabarit aurait choisi — plutôt que d'enregistrer une chaîne vide et de
  // livrer un fichier nommé `document.pdf`.
  const title = safeTitle.text.length > 0 ? safeTitle.text : DEFAULT_TITLES[data.type];
  const content = safeContent.text;

  return { title, content };
}

/**
 * Produit le fichier — ou dit pourquoi il n'a pas pu.
 *
 * ⚠️ **Ne LÈVE jamais.** Le texte du document est déjà écrit à ce stade et sera enregistré
 * quoi qu'il arrive : un échec de rendu ne doit pas le perdre. Le verdict porte l'échec sous
 * `failure`, l'appelant décide.
 *
 * ⚠️ Le repli sur PDF n'est PAS atteignable par le chemin Zod — le schéma n'expose que `pdf`
 * et `docx`, qui ont tous deux un renderer. Il existe pour les appelants hors LLM (workflow,
 * appel direct), à qui un échec sec sur une valeur que le schéma n'expose plus serait un
 * piège. Et le format RENDU est celui réellement produit, jamais celui demandé : sinon la
 * base annoncerait un `csv` là où un PDF a été livré.
 */
async function renderDocument(params: {
  renderers: readonly DocumentRenderer[];
  type: DocumentType;
  format: DocumentFormat;
  title: string;
  content: string;
  employee: {
    firstName: string;
    lastName: string;
    email: string;
    department?: string | null;
    position?: string;
    startDate?: string;
  };
  interview: Awaited<ReturnType<typeof readInterview>>;
}): Promise<{
  rendered: RenderedDocument | undefined;
  producedFormat: DocumentFormat;
  failure: HintKey | undefined;
}> {
  const { renderers, type, format, title, content, employee, interview } = params;

  // ---------------------------------------------------------------------
  // Rendu
  // ---------------------------------------------------------------------
  //
  // Repli sur PDF quand le format demandé n'a pas de renderer : l'utilisateur reçoit
  // un fichier réel plutôt que rien, et le résultat NOMME le format effectivement
  // produit — le modèle peut donc dire la vérité (« je te l'ai fait en PDF »). Un
  // échec sec sur une valeur que le schéma n'expose même plus serait un piège pour
  // les seuls appelants hors LLM.
  const renderer =
    renderers.find((candidate) => candidate.format === format) ??
    renderers.find((candidate) => candidate.format === DocumentFormat.Pdf);

  let rendered: RenderedDocument | undefined;
  let failure: HintKey | undefined;

  if (!renderer) {
    // Câblage incomplet : on enregistre quand même, on ne perd pas le texte produit.
    logger.error('Aucun renderer disponible — document enregistré sans fichier', {
      format: format,
    });
    failure = 'not_rendered';
  } else {
    try {
      rendered = await renderer.render({
        type: type,
        title,
        content,
        interview,
        employee: {
          firstName: employee.firstName,
          lastName: employee.lastName,
          email: employee.email,
          // `?? undefined` : le gabarit distingue « absent » de « vide ». Un `null` qui
          // traverserait finirait imprimé tel quel dans un PDF signé de l'entreprise.
          department: employee.department ?? undefined,
          position: employee.position,
          startDate: employee.startDate,
        },
      });
    } catch (error: unknown) {
      logger.error('Rendu du document échoué — enregistrement sans fichier', {
        format: renderer.format,
        error: errorMessage(error),
      });
      failure = 'not_rendered';
    }
  }

  // Le format ENREGISTRÉ est celui réellement produit, jamais celui demandé : sinon
  // la base annoncerait un `csv` là où un PDF a été livré.
  const producedFormat = rendered ? (renderer?.format ?? format) : format;

  return { rendered, producedFormat, failure };
}

/**
 * Où le document doit aller. Volontairement plus étroit que `DeliveryVerdict` : c'est une
 * INTENTION, elle ne peut pas valoir `failed`.
 */
type DeliveryIntent = 'slack' | 'email' | 'none';

/** Le couple rendu par toutes les étapes de livraison : où c'est parti, et pourquoi sinon. */
interface DeliveryOutcome {
  delivery: DeliveryVerdict;
  reason: HintKey | undefined;
}

/** Traduit le résultat d'un envoi email en verdict de livraison. */
function toVerdict(sent: { ok: true } | { ok: false; reason: HintKey }): DeliveryOutcome {
  return sent.ok
    ? { delivery: 'email', reason: undefined }
    : { delivery: 'failed', reason: sent.reason };
}

/**
 * Livraison Slack, avec son repli email.
 *
 * ⚠️ **Le repli se déclenche sur TOUT échec Slack**, et c'est un correctif à ne pas
 * re-restreindre. Il ne portait que sur `missing_scope` — or les logs de production du
 * 2026-08-11 prouvent que le scope `files:write` EST accordé
 * (`{"filename":"guide-….pdf","hasPermalink":true}`). La condition était donc devenue du CODE
 * MORT : `not_in_channel`, un 5xx Slack ou un réseau coupé donnaient `delivery: 'failed'` sec,
 * sans qu'aucun repli ne soit tenté, alors qu'un fichier réel était prêt et qu'une adresse
 * d'annuaire était connue.
 *
 * L'argument d'origine — « ne pas écrire à quelqu'un qui n'a rien demandé » — ne tient pas
 * ici : le destinataire est l'employé concerné par le document, qui vient précisément d'être
 * demandé, et l'alternative n'est pas « ne rien envoyer » mais « perdre le document ».
 *
 * Le verdict reste honnête : `email` seulement si l'envoi a réussi, et `reason` nomme toujours
 * `missing_scope` quand il est en jeu — c'est la seule cause qui appelle un geste humain.
 */
async function deliverToSlack(params: {
  slackCtx: { channel: string; threadTs?: string };
  fileUpload: FileUploadProvider | undefined;
  emailProvider: EmailProvider | undefined;
  employeeEmail: string | null | undefined;
  title: string;
  rendered: RenderedDocument;
}): Promise<DeliveryOutcome> {
  const { slackCtx, fileUpload, emailProvider, employeeEmail, title, rendered } = params;

  try {
    const { permalink } = await uploadToSlack(fileUpload, slackCtx, rendered, title);
    // Le permalink est journalisé, JAMAIS retourné au modèle : le fichier est déjà dans le
    // fil, et remettre une URL dans le contexte rouvrirait la porte par laquelle le faux lien
    // de téléchargement est passé.
    logger.info('Document livré dans Slack', {
      channel: slackCtx.channel,
      filename: rendered.filename,
      hasPermalink: Boolean(permalink),
    });
    return { delivery: 'slack', reason: undefined };
  } catch (error: unknown) {
    const missingScope = isMissingScope(error);
    logger.error('Livraison Slack échouée', {
      channel: slackCtx.channel,
      missingScope,
      error: errorMessage(error),
    });

    const fallback = toVerdict(
      await deliverByEmail(emailProvider, employeeEmail ?? undefined, title, rendered),
    );
    if (fallback.delivery === 'email') return fallback;
    return { delivery: 'failed', reason: missingScope ? 'missing_scope' : fallback.reason };
  }
}

/**
 * La LIVRAISON, et rien d'autre : Slack, email, ou le repli de l'un vers l'autre.
 *
 * ⚠️ Extraite le 2026-08-18. C'était le nœud de complexité de `execute` — trois branches, un
 * `try/catch`, un repli, et deux variables mutables (`delivery`, `reason`) qui traversaient
 * tout le reste de la fonction. Rendre un couple `{ delivery, reason }` les supprime et rend
 * le repli testable seul.
 *
 * ⚠️ **AUCUNE exception ne sort d'ici**, et c'est le contrat : le document est déjà rendu à ce
 * stade, et une livraison ratée ne doit jamais empêcher son enregistrement. Le verdict porte
 * l'échec, il ne le lève pas.
 */
async function deliver(params: {
  intent: DeliveryIntent;
  rendered: RenderedDocument | undefined;
  slackCtx: { channel: string; threadTs?: string } | undefined;
  fileUpload: FileUploadProvider | undefined;
  emailProvider: EmailProvider | undefined;
  employeeEmail: string | null | undefined;
  employeeId: string;
  title: string;
  failure: HintKey | undefined;
}): Promise<DeliveryOutcome> {
  const {
    intent: effectiveDeliverTo,
    rendered,
    slackCtx,
    fileUpload,
    emailProvider,
    employeeEmail,
    employeeId,
    title,
    failure,
  } = params;

  const delivery: DeliveryVerdict = 'none';
  const reason: HintKey | undefined = failure;

  if (!rendered || effectiveDeliverTo === 'none') return { delivery, reason };

  // Email demandé explicitement : un seul chemin, sans repli — il n'y a rien vers quoi se
  // replier.
  if (effectiveDeliverTo === 'email') {
    return toVerdict(
      await deliverByEmail(emailProvider, employeeEmail ?? undefined, title, rendered),
    );
  }

  // Slack demandé, mais sans canal : cas NORMAL, pas une panne — playground Mastra, route
  // HTTP, workflow, test. Il n'y a personne à qui livrer, on le dit, on n'échoue pas.
  if (!slackCtx) {
    logger.info('Pas de contexte Slack — document enregistré sans livraison', { employeeId });
    return { delivery: 'none', reason: 'no_slack_context' };
  }

  return await deliverToSlack({
    slackCtx,
    fileUpload,
    emailProvider,
    employeeEmail,
    title,
    rendered,
  });
  return { delivery, reason };
}

/** Livraison Slack. Lève — l'appelant décide du repli. */
async function uploadToSlack(
  fileUpload: FileUploadProvider | undefined,
  slackContext: { channel: string; threadTs?: string },
  rendered: RenderedDocument,
  title: string,
): Promise<{ permalink?: string }> {
  if (!fileUpload) throw new Error('Aucun fournisseur de fichiers câblé');

  // `threadTs` n'est posé que s'il existe : en DM il est `undefined` PAR CONCEPTION, et
  // threader un DM enfouit le fichier hors de la conversation principale.
  return await fileUpload.uploadFile({
    channel: slackContext.channel,
    ...(slackContext.threadTs ? { threadTs: slackContext.threadTs } : {}),
    bytes: rendered.bytes,
    filename: rendered.filename,
    title,
  });
}

/**
 * Livraison email. Ne lève JAMAIS : elle sert aussi de repli à la livraison Slack, et un
 * repli qui explose transformerait une dégradation en panne.
 *
 * L'adresse vient de l'annuaire, jamais du modèle (voir le modèle de menace en tête).
 */
async function deliverByEmail(
  emailProvider: EmailProvider | undefined,
  to: string | undefined,
  title: string,
  rendered: RenderedDocument,
): Promise<{ ok: true } | { ok: false; reason: HintKey }> {
  if (!to) {
    logger.error('Livraison email impossible — aucune adresse dans l’annuaire');
    return { ok: false, reason: 'no_email' };
  }
  if (!emailProvider) {
    logger.error('Livraison email impossible — aucun fournisseur email câblé');
    return { ok: false, reason: 'delivery_failed' };
  }

  try {
    await emailProvider.sendEmail(to, title, `Voici le document « ${title} ».`, [
      { filename: rendered.filename, bytes: rendered.bytes, mimeType: rendered.mimeType },
    ]);
    logger.info('Document livré par email', { filename: rendered.filename });
    return { ok: true };
  } catch (error: unknown) {
    logger.error('Livraison email échouée', { error: errorMessage(error) });
    return { ok: false, reason: 'delivery_failed' };
  }
}
