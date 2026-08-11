/**
 * Traduction entité `Document` ↔ ligne `documents`.
 *
 * ── Pourquoi ces mappers existent ───────────────────────────────────────────
 * `DrizzleDocumentRepository` se contentait de deux assertions :
 *
 *     function toDomain(row)  { return row as unknown as Document; }
 *     function toPersistence(doc) { return doc as unknown as typeof documents.$inferInsert; }
 *
 * `as unknown as` désactive TOUTE vérification : le compilateur ne peut plus
 * signaler qu'un champ de l'entité n'a pas de colonne. C'est précisément ce qui
 * est arrivé à `content`. Drizzle, de son côté, ignore silencieusement une clé
 * de `.values()` qui ne correspond à aucune colonne déclarée — vérifié
 * empiriquement : avec la colonne PRÉSENTE en base mais absente de `schema.ts`,
 * la ligne s'écrit avec `content` à NULL, sans le moindre avertissement.
 *
 * Résultat mesuré sur la Turso de production le 2026-08-11 : 6 documents
 * enregistrés, 6 documents vides. `generateDocument` annonçait un succès pour
 * une écriture qui perdait l'essentiel.
 *
 * Ces mappers énumèrent donc les champs un par un, sans assertion. Le typage
 * REFUSE désormais un champ non persisté : ajouter une propriété à `Document`
 * sans colonne correspondante casse la compilation, au lieu de disparaître.
 */

import type { documents } from '../../../../infrastructure/database/schema';
import type { Document } from '../../domain/entities/document';
import type { DocumentFormat, DocumentStatus, DocumentType } from '../../../../shared/types';

type DocumentRow = typeof documents.$inferSelect;
type DocumentInsert = typeof documents.$inferInsert;

/**
 * Entité → ligne.
 *
 * Les colonnes de STOCKAGE (`storageKey`, `fileName`, `fileSize`, `mimeType`,
 * `storageBucket`) restent volontairement absentes : aucun fichier n'est écrit
 * nulle part. Les renseigner décrirait un objet inexistant — et c'est
 * exactement le genre de promesse qui a produit le faux lien de téléchargement
 * `https://kisso.internal/docs/<uuid>/download` du 2026-08-11.
 */
export function toPersistenceDocument(doc: Document): DocumentInsert {
  return {
    id: doc.id,
    employeeId: doc.employeeId,
    type: doc.type,
    title: doc.title,
    content: doc.content,
    format: doc.format,
    status: doc.status,
    generatedAt: doc.generatedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Ligne → entité.
 *
 * `content` peut être NULL en base : les documents écrits AVANT la colonne le
 * sont tous. L'entité, elle, déclare `content: string` — on rend donc une
 * chaîne vide plutôt que de propager un `null` que le type interdit et qu'un
 * appelant afficherait tel quel.
 */
export function toDomainDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    employeeId: row.employeeId,
    type: row.type as DocumentType,
    title: row.title,
    content: row.content ?? '',
    format: row.format as DocumentFormat,
    status: row.status as DocumentStatus,
    generatedAt: row.generatedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
