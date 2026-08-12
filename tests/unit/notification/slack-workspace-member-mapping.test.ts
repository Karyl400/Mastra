import { describe, it, expect } from 'vitest';
import { toMember } from '../../../src/features/notification/infrastructure/providers/slack-workspace.service';

/**
 * Projection `users.*` → `SlackMember`.
 *
 * Testée DIRECTEMENT plutôt qu'à travers un `WebClient` simulé : c'est sur ces
 * drapeaux que se décide la politique d'autorisation (P1, rétrogradation des
 * invités en lecture seule), et les éprouver via le transport ferait dépendre
 * une règle métier de la forme d'une réponse HTTP.
 *
 * `toMember` est privée au module jusqu'à ce fichier ; elle est exportée pour
 * qu'une seule projection reste partagée par `listMembers`, `getUserById` et
 * `findUserByEmail` — la dupliquer dans un test l'aurait figée dans son état
 * d'aujourd'hui sans rien garantir de la vraie.
 */
describe('Notification: projection SlackMember (toMember)', () => {
  it('projette un membre nominal', () => {
    const member = toMember({
      id: 'U01',
      name: 'jean.dupont',
      real_name: 'Jean Dupont',
      is_bot: false,
      is_admin: false,
      is_restricted: false,
      is_ultra_restricted: false,
      deleted: false,
      team_id: 'TMLKC4EPP',
      profile: {
        email: 'jean.dupont@kisso.com',
        first_name: 'Jean',
        last_name: 'Dupont',
        display_name: 'jdupont',
      },
    });

    expect(member).toEqual({
      id: 'U01',
      name: 'jean.dupont',
      realName: 'Jean Dupont',
      email: 'jean.dupont@kisso.com',
      firstName: 'Jean',
      lastName: 'Dupont',
      displayName: 'jdupont',
      // `profile.title` absent de la réponse Slack : la projection rend la chaîne vide, pas
      // `undefined` — `SlackMember` n'a aucun champ optionnel.
      title: '',
      isRestricted: false,
      isUltraRestricted: false,
      isDeleted: false,
      isBot: false,
      isAdmin: false,
      teamId: 'TMLKC4EPP',
    });
  });

  it('remonte un invité multi-canal', () => {
    const member = toMember({
      id: 'U02',
      name: 'presta',
      real_name: 'Presta Externe',
      is_restricted: true,
      is_ultra_restricted: false,
      profile: { email: 'presta@agence.com' },
    });

    expect(member.isRestricted).toBe(true);
    expect(member.isUltraRestricted).toBe(false);
  });

  it('remonte un invité mono-canal SANS écraser le drapeau multi-canal', () => {
    // Slack pose les DEUX drapeaux sur un invité mono-canal. On les lit tels
    // quels : déduire l'un de l'autre interdirait à la politique de durcir le
    // seul cas mono-canal.
    const member = toMember({
      id: 'U03',
      name: 'audit',
      real_name: 'Auditeur Externe',
      is_restricted: true,
      is_ultra_restricted: true,
      profile: { email: 'audit@cabinet.com' },
    });

    expect(member.isRestricted).toBe(true);
    expect(member.isUltraRestricted).toBe(true);
  });

  it('rend `email: null` — jamais une chaîne vide — pour un compte sans email', () => {
    // Une chaîne vide passerait une simple validation de présence.
    const member = toMember({ id: 'U04', name: 'sansmail', profile: {} });

    expect(member.email).toBeNull();
  });

  it('retombe sur les valeurs neutres quand `profile` est absent', () => {
    const member = toMember({ id: 'U05', name: 'brut' });

    expect(member).toMatchObject({
      email: null,
      firstName: '',
      lastName: '',
      displayName: 'brut',
      isRestricted: false,
      isUltraRestricted: false,
      isDeleted: false,
    });
  });

  it('dérive prénom et nom de `real_name` quand le profil ne les porte pas', () => {
    const member = toMember({
      id: 'U06',
      name: 'marie',
      real_name: 'Marie Claire Dupont',
      profile: { email: 'marie@kisso.com' },
    });

    expect(member).toMatchObject({ firstName: 'Marie', lastName: 'Claire Dupont' });
  });

  it('survit à un compte sans `real_name`', () => {
    // Compte fraîchement invité : Slack ne renseigne parfois que `name`.
    const member = toMember({ id: 'U07', name: 'nouveau', profile: { email: 'n@kisso.com' } });

    expect(member).toMatchObject({
      realName: '',
      firstName: '',
      lastName: '',
      // La cascade descend jusqu'à `name` : un refus d'autorisation doit
      // toujours pouvoir nommer quelqu'un.
      displayName: 'nouveau',
    });
  });

  it('projette un bot', () => {
    const member = toMember({
      id: 'UBOT',
      name: 'kisso-bot',
      real_name: 'Kisso Bot',
      is_bot: true,
      team_id: 'TMLKC4EPP',
      profile: {},
    });

    expect(member).toMatchObject({
      isBot: true,
      isRestricted: false,
      isUltraRestricted: false,
      isDeleted: false,
      displayName: 'Kisso Bot',
    });
  });

  it('remonte `isDeleted: true` pour un compte désactivé', () => {
    // C'est ce qui permet à la politique de REFUSER un ancien salarié, là où un
    // compte inconnu (`null` rendu par le port) est seulement rétrogradé.
    const member = toMember({
      id: 'U08',
      name: 'parti',
      real_name: 'Ancien Salarié',
      deleted: true,
      profile: { email: 'parti@kisso.com' },
    });

    expect(member.isDeleted).toBe(true);
    expect(member.email).toBe('parti@kisso.com');
  });

  it('traite les CHAÎNES VIDES de Slack comme des valeurs absentes', () => {
    // Piège central de cette projection : Slack renvoie `''`, pas `undefined`,
    // pour un champ de profil non renseigné. Avec `??`, `firstName`,
    // `lastName` et `displayName` seraient vides — et un refus d'autorisation
    // serait journalisé sans aucun nom.
    const member = toMember({
      id: 'U09',
      name: 'karyl',
      real_name: 'Karyl SOUMAILA',
      profile: {
        email: 'karyl@kisso.com',
        first_name: '',
        last_name: '',
        display_name: '',
        real_name: '',
      },
    });

    expect(member.firstName).toBe('Karyl');
    expect(member.lastName).toBe('SOUMAILA');
    expect(member.displayName).toBe('Karyl SOUMAILA');
  });

  it('préfère `profile.real_name` à `real_name` quand `display_name` est vide', () => {
    const member = toMember({
      id: 'U10',
      name: 'compte',
      real_name: 'Nom Racine',
      profile: { display_name: '', real_name: 'Nom Profil' },
    });

    expect(member.displayName).toBe('Nom Profil');
  });

  it('rend des valeurs neutres — jamais `undefined` — sur une réponse vide', () => {
    // `SlackMember` n'a aucun champ optionnel : un `undefined` qui traverserait
    // la projection ferait échouer la politique sur un `.toLowerCase()` plutôt
    // que de décider.
    const member = toMember({});

    expect(member).toEqual({
      id: '',
      name: '',
      realName: '',
      email: null,
      firstName: '',
      lastName: '',
      displayName: '',
      title: '',
      isRestricted: false,
      isUltraRestricted: false,
      isDeleted: false,
      isBot: false,
      isAdmin: false,
      teamId: '',
    });
  });
});
