import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { QuestionnaireRepository } from '../../domain/ports/questionnaire.repository';
import { createQuestionnaire } from '../../domain/entities/questionnaire';
import { sanitizeText } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { QuestionnaireStatus } from '../../../../shared/types';

/**
 * Schéma de question **exposé au LLM** — volontairement plus étroit que
 * `questionSchema` de `shared/validation`, qui reste la référence côté DTO/API.
 *
 * Le schéma JSON d'un tool est réinjecté INTÉGRALEMENT à chaque aller-retour, et
 * celui-ci est imbriqué dans un `z.array()` : c'était le poste de coût dominant de
 * tous les tools du projet (295 tokens de schéma). Deux champs ont été retirés de
 * la surface exposée au modèle car l'entité `Question` ne les porte pas et aucun
 * code ne les lit :
 *   - `description` : le `label` porte déjà l'énoncé ;
 *   - `order` : l'ordre est celui du tableau.
 * Les autres champs, les bornes de longueur et la sanitization sont conservés à
 * l'identique. Les `refine` ci-dessous sont GRATUITS en tokens (`zodToJsonSchema`
 * les ignore) : ils reproduisent les invariants de `questionSchema`.
 *
 * ⚠️ Sérialisation PLATE obligatoire — pas de `.pipe()`, `z.union`,
 * `z.discriminatedUnion`. Verrouillé par `tests/unit/tools/tool-schema-flatness.test.ts`.
 */
const questionInputSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['text', 'choice', 'multiple_choice', 'scale', 'boolean', 'date', 'file_upload']),
    label: z.string().min(1).max(500).transform(sanitizeText),
    required: z.boolean().default(false),
    options: z.array(z.string().min(1).max(200).transform(sanitizeText)).min(1).max(50).optional(),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
  })
  .refine((q) => !['choice', 'multiple_choice'].includes(q.type) || q.options !== undefined, {
    message: 'Options are required for choice/multiple_choice question types',
    path: ['options'],
  })
  .refine((q) => q.type !== 'scale' || (q.min !== undefined && q.max !== undefined), {
    message: 'Min and max are required for scale question type',
    path: ['min'],
  })
  .refine(
    (q) => q.type !== 'scale' || q.min === undefined || q.max === undefined || q.min < q.max,
    {
      message: 'Min must be less than max',
      path: ['max'],
    },
  );

type QuestionInput = z.infer<typeof questionInputSchema>;

const generateQuestionnaireInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  questions: z
    .array(questionInputSchema)
    .min(1)
    .describe('choice/multiple_choice exigent options ; scale exige min et max'),
});

export function makeGenerateQuestionnaire(repo: QuestionnaireRepository) {
  return createTool({
    id: 'generateQuestionnaire',
    description: 'Crée un questionnaire et ses questions',
    inputSchema: generateQuestionnaireInputSchema,
    execute: async (data, _ctx) => {
      logger.info('Création questionnaire', { title: data.title });
      const questionnaire = createQuestionnaire({
        id: crypto.randomUUID(),
        title: data.title,
        description: data.description ?? '',
        questions: data.questions.map((q: QuestionInput) => ({ ...q, text: q.label })),
      });
      const published = {
        ...questionnaire,
        status: QuestionnaireStatus.Published,
        updatedAt: new Date().toISOString(),
      };
      await repo.save(published);
      logger.info('Questionnaire créé', {
        id: published.id,
        questionCount: questionnaire.questions.length,
      });

      // ⚠️ PROJECTION, jamais l'entité. Quatrième occurrence du même défaut dans ce dépôt,
      // après `getEmployeeProfile` (2506 → 333), `generateDocument` (685 → 39) et
      // `getNotificationHistory` (≈ 9600 → 177).
      //
      // `return published` renvoyait `questions[]` en entier — c'est-à-dire l'énoncé, les
      // options et les bornes que le MODÈLE VENAIT LUI-MÊME D'ÉCRIRE, refacturés au modèle,
      // puis réémis à chaque étape suivante du run. Un questionnaire de 8 questions à choix
      // multiple pèse ainsi plusieurs centaines de tokens qui n'apprennent rien à personne :
      // l'auteur du texte est son destinataire.
      //
      // La propriété qui compte n'est pas le chiffre mais l'INDÉPENDANCE : la taille de ce
      // retour ne dépend plus ni du nombre de questions ni de leur longueur. `questionCount`
      // suffit à ce que l'agent puisse dire ce qu'il a produit, `id` à ce qu'on le retrouve.
      return {
        id: published.id,
        title: published.title,
        questionCount: questionnaire.questions.length,
        status: published.status,
      };
    },
  });
}
