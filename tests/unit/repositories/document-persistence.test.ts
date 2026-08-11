import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';

import {
  toDomainDocument,
  toPersistenceDocument,
} from '../../../src/features/document/infrastructure/repositories/document.mapper';
import { documents } from '../../../src/infrastructure/database/schema';
import { createDocument } from '../../../src/features/document/domain/entities/document';
import { DocumentFormat, DocumentStatus, DocumentType } from '../../../src/shared/types';

/**
 * PERTE DE DONNÉES vérifiée sur la Turso de production le 2026-08-11 : les 6
 * lignes de `documents` ont `storage_key`, `file_name`, `file_size` et
 * `mime_type` à NULL, et le CONTENU du document n'est nulle part. `generateDocument`
 * enregistrait donc des coquilles : titre, type, format — et rien du texte
 * produit.
 *
 * Mécanisme : `documents` n'a pas de colonne `content`, et Drizzle IGNORE
 * silencieusement toute clé de `.values()` qui ne correspond à aucune colonne
 * déclarée (vérifié empiriquement : la ligne s'écrit avec `content` à NULL
 * alors même que la colonne EXISTE en base, tant qu'elle n'est pas déclarée
 * côté Drizzle). Le `as unknown as` des deux mappers rendait la faute invisible
 * au compilateur : il effaçait l'écart entre l'entité et la table.
 */

const EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';

function doc() {
  return {
    ...createDocument({
      id: '22222222-2222-4222-8222-222222222222',
      employeeId: EMPLOYEE_ID,
      type: DocumentType.Guide,
      title: 'Guide de démarrage',
      content: 'Bienvenue chez Kisso. Voici les règles internes…',
      format: DocumentFormat.Txt,
    }),
    status: DocumentStatus.Generated,
    generatedAt: '2026-08-11T10:00:00.000Z',
  };
}

describe('toPersistenceDocument', () => {
  it('persiste le CONTENU du document', () => {
    const row = toPersistenceDocument(doc());

    expect(row.content).toBe('Bienvenue chez Kisso. Voici les règles internes…');
  });

  it('projette chaque champ de l entité sur une colonne', () => {
    const row = toPersistenceDocument(doc());

    expect(row).toMatchObject({
      id: '22222222-2222-4222-8222-222222222222',
      employeeId: EMPLOYEE_ID,
      type: DocumentType.Guide,
      title: 'Guide de démarrage',
      format: DocumentFormat.Txt,
      status: DocumentStatus.Generated,
      generatedAt: '2026-08-11T10:00:00.000Z',
    });
  });

  it("laisse les colonnes de STOCKAGE à null : aucun fichier n'existe", () => {
    // Renseigner `file_name` ou `file_size` pour un fichier qui n'a jamais été
    // écrit fabriquerait exactement le genre de promesse qui a produit le faux
    // lien de téléchargement du 2026-08-11.
    const row = toPersistenceDocument(doc()) as Record<string, unknown>;

    for (const champ of ['storageKey', 'storageBucket', 'fileName', 'fileSize', 'mimeType']) {
      expect(row[champ] ?? null).toBeNull();
    }
  });
});

describe('toDomainDocument', () => {
  it('fait l aller-retour sans perdre le contenu', () => {
    const original = doc();
    const restitue = toDomainDocument(toPersistenceDocument(original) as never);

    expect(restitue).toEqual(original);
  });

  it('rend une chaîne vide plutôt que null pour un contenu absent', () => {
    // Les 6 documents déjà en production ont été écrits sans contenu : la
    // lecture ne doit pas rendre un `Document` dont `content` vaut `null` alors
    // que l'entité le déclare `string`.
    const row = { ...toPersistenceDocument(doc()), content: null };
    expect(toDomainDocument(row as never).content).toBe('');
  });
});

/**
 * GARDE-FOU : la colonne doit exister CÔTÉ DRIZZLE.
 *
 * Ce n'est pas une redite du test de mapping. Drizzle construit son INSERT à
 * partir des colonnes DÉCLARÉES : tant que `content` manque à `schema.ts`, la
 * valeur est écartée en silence même si la colonne existe en base. C'est
 * exactement le mode de panne d'origine, et il ne se voit dans aucun test qui
 * n'interroge que les mappers.
 */
describe('schema.documents — colonne content', () => {
  it('déclare une colonne `content` mappée sur la colonne SQL du même nom', () => {
    const colonnes = getTableColumns(documents) as Record<string, { name: string }>;

    expect(colonnes).toHaveProperty('content');
    expect(colonnes.content?.name).toBe('content');
  });

  it("n'a pas de colonne `content` NOT NULL : les 6 documents déjà écrits n'en ont pas", () => {
    const colonnes = getTableColumns(documents) as Record<string, { notNull: boolean }>;

    expect(colonnes.content?.notNull).toBe(false);
  });
});
