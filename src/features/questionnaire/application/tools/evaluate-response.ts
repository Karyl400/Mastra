import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { QuestionnaireRepository } from '../../domain/ports/questionnaire.repository';
import type { ResponseRepository } from '../../domain/ports/response.repository';
import { createResponse } from '../../domain/entities/questionnaire';
import { uuidSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { NotFoundError } from '../../../../shared/errors';
import { ResponseStatus } from '../../../../shared/types';

export function makeEvaluateResponse(
  questionnaireRepo: QuestionnaireRepository,
  responseRepo: ResponseRepository,
) {
  return createTool({
    id: 'evaluateResponse',
    // La description dit « enregistre » et « complétion », jamais « évalue » ni
    // « note » : le mot que lit le modèle est celui qu'il répétera à l'utilisateur,
    // et ce tool ne corrige RIEN (voir le commentaire du calcul plus bas).
    description:
      "Enregistre les réponses d'un employé à un questionnaire et calcule son taux de complétion. " +
      'Ne corrige pas les réponses et ne produit aucune note.',
    inputSchema: z.object({
      questionnaireId: uuidSchema.describe('ID du questionnaire'),
      employeeId: uuidSchema.describe('ID de l employé'),
      // ⚠️ Tableau de paires, JAMAIS `z.record()` — mesuré en production le
      // 2026-08-12 : `z.record(z.unknown())` sérialise en
      // `{"type":"object","additionalProperties":{}}`, un objet sans `properties`,
      // et Groq rejette alors TOUTE clé :
      //   `/answers`: additionalProperties 'q1','q2','q3' not allowed
      // Le tool était donc inappelable à 100 %, et chaque tentative brûlait un
      // aller-retour LLM complet — sous un quota de ~19 messages/jour.
      // Verrouillé par `tests/unit/tools/tool-schema-flatness.test.ts`.
      answers: z
        .array(
          z.object({
            questionId: z.string().min(1).max(100),
            answer: z.string().max(2000),
          }),
        )
        .min(1)
        .describe('Une entrée par question répondue'),
    }),
    execute: async (data, _ctx) => {
      logger.info('Évaluation réponses', {
        questionnaireId: data.questionnaireId,
        employeeId: data.employeeId,
      });

      const questionnaire = await questionnaireRepo.findById(data.questionnaireId);
      if (!questionnaire) throw new NotFoundError('Questionnaire', data.questionnaireId);

      // Le domaine stocke `answers` en `Record<string, unknown>` ; seule la forme
      // EXPOSÉE AU MODÈLE devient un tableau. La conversion vit ici, à la frontière
      // du tool, pour ne pas propager une contrainte de sérialisation LLM dans
      // l'entité ni dans le repository.
      const answersRecord: Record<string, unknown> = {};
      for (const { questionId, answer } of data.answers) answersRecord[questionId] = answer;

      const total = questionnaire.questions.length;

      // ⚠️ Ce chiffre est un taux de COMPLÉTION, pas une note : les questions ne
      // portent aucune bonne réponse (`questionInputSchema` de
      // `generate-questionnaire.ts` n'a pas de champ `expectedAnswer`), donc rien
      // ici ne peut comparer quoi que ce soit. Le nom `score` restait persisté en
      // base tout en étant rapporté au modèle comme une évaluation — quatrième
      // occurrence dans ce dépôt de la signature « le champ dit mieux que le fait »
      // (`emailSent:false` sous `status:'success'`, `documents.content` perdu en
      // silence, `status = Sent` posé avant le `try`).
      //
      // On ne compte que les réponses portant l'ID d'une question RÉELLE du
      // questionnaire : `Object.keys(answers).length` acceptait n'importe quelle
      // clé, donc trois clés inventées donnaient 100 % sur un questionnaire de
      // trois questions.
      const knownIds = new Set(questionnaire.questions.map((q: { id: string }) => q.id));
      const answered = Object.keys(answersRecord).filter((id) => knownIds.has(id)).length;
      const unknownAnswers = Object.keys(answersRecord).length - answered;
      const completionPercent = total > 0 ? Math.round((answered / total) * 100) : 0;

      const response = createResponse({
        id: crypto.randomUUID(),
        questionnaireId: data.questionnaireId,
        employeeId: data.employeeId,
        answers: answersRecord,
        score: completionPercent,
        submittedAt: new Date().toISOString(),
      });
      const evaluated = {
        ...response,
        status: ResponseStatus.Reviewed,
        updatedAt: new Date().toISOString(),
      };
      await responseRepo.save(evaluated);

      return {
        responseId: evaluated.id,
        completionPercent,
        totalQuestions: total,
        answeredQuestions: answered,
        // Sans ce champ, une réponse dont TOUS les identifiants sont faux rendait
        // `answeredQuestions: 0` sans jamais dire pourquoi.
        unknownAnswers,
        graded: false as const,
        status: evaluated.status,
      };
    },
  });
}
