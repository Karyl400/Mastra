import { describe, it, expect } from 'vitest';

import {
  parseInterviewSchedule,
  MAX_INTERVIEW_HORIZON_MS,
} from '../../../src/features/recruitment/domain/value-objects/interview-schedule';
import {
  buildInterviewEmail,
  checkInterviewLocation,
} from '../../../src/features/recruitment/domain/services/interview-email';

const NOW = new Date('2026-08-14T10:00:00.000Z');
const OK = new Date('2026-08-20T13:00:00.000Z'); // 14:00 en UTC+1

function scheduleOf(iso: string, now = NOW) {
  const parsed = parseInterviewSchedule(iso, now);
  if (!parsed.ok) throw new Error(`attendu valide : ${parsed.reason}`);
  return parsed.schedule;
}

describe('parseInterviewSchedule — les deux erreurs de TRANSCRIPTION', () => {
  it('REFUSE une date passée — l’erreur d’ANNÉE, la plus fréquente', () => {
    // Un modèle écrit volontiers l'année sur laquelle il a été entraîné : « le 20 août » →
    // `2025-08-20`. Aucune validation Zod ne le voit, la chaîne ISO est parfaite.
    const out = parseInterviewSchedule('2025-08-20T13:00:00.000Z', NOW);
    expect(out).toEqual({ ok: false, reason: 'date_in_past' });
  });

  it('REFUSE une date à plus d’un an — la même faute dans l’autre sens', () => {
    const out = parseInterviewSchedule('2028-08-20T13:00:00.000Z', NOW);
    expect(out).toEqual({ ok: false, reason: 'date_too_far' });
  });

  it('REFUSE une chaîne qui n’est pas une date', () => {
    expect(parseInterviewSchedule('mardi prochain', NOW)).toEqual({
      ok: false,
      reason: 'invalid_date',
    });
  });

  it('accepte jusqu’à la borne, et pas au-delà', () => {
    const justInside = new Date(NOW.getTime() + MAX_INTERVIEW_HORIZON_MS - 60_000);
    const justOutside = new Date(NOW.getTime() + MAX_INTERVIEW_HORIZON_MS + 60_000);
    expect(parseInterviewSchedule(justInside.toISOString(), NOW).ok).toBe(true);
    expect(parseInterviewSchedule(justOutside.toISOString(), NOW).ok).toBe(false);
  });

  it('rend une date VÉRIFIABLE par un humain, fuseau compris', () => {
    // C'est tout l'objet : `2026-08-20T13:00:00.000Z` ne dit rien à personne, et une erreur
    // d'heure y est invisible. Sous cette forme, elle saute aux yeux.
    const schedule = scheduleOf(OK.toISOString());
    expect(schedule.humanReadable).toContain('20 août 2026');
    expect(schedule.humanReadable).toContain('14:00');
    expect(schedule.humanReadable).toMatch(/UTC\+01:00/);
    expect(schedule.shortLabel).toContain('20 août');
  });
});

describe('buildInterviewEmail — le gabarit, et ce qu’il OMET', () => {
  const base = { candidateName: 'Jean Dupont', schedule: scheduleOf(OK.toISOString()) };

  it('nomme la personne, la date et le fuseau', () => {
    const mail = buildInterviewEmail(base);
    expect(mail.subject).toContain('Kisso Industries');
    expect(mail.subject).toContain('20 août');
    expect(mail.body).toContain('Bonjour Jean Dupont,');
    expect(mail.body).toContain('14:00');
    expect(mail.body).toContain('UTC+01:00');
  });

  it('OMET proprement le poste absent, au lieu de l’inventer', () => {
    const mail = buildInterviewEmail(base);
    expect(mail.body).toContain('Nous avons le plaisir de vous convier à un entretien.');
    expect(mail.body).not.toContain('undefined');
    expect(mail.body).not.toContain('poste de');
  });

  it('cite le poste quand il est fourni', () => {
    const mail = buildInterviewEmail({ ...base, position: 'Développeur backend' });
    expect(mail.body).toContain('pour le poste de Développeur backend');
  });

  it('salue SANS NOM quand aucun nom n’a été donné — défaut observé en production', () => {
    // ⚠️ Régression réelle du 2026-08-14. `candidateName` était REQUIS ; sur « Envoie un email
    // d'entretien à ridwanenico77@gmail.com pour le 20 août », le modèle a rendu
    // `candidateName: "Ridwane Nico"` — un nom FABRIQUÉ à partir de l'adresse, que personne
    // n'avait donné. Un champ requis force l'invention, et aucune validation Zod ne peut la
    // voir : la valeur produite est parfaitement bien formée. Même mécanique que
    // `createEmployee` substituant une valeur d'allowlist valide.
    //
    // Une salutation sans nom vaut mieux qu'une salutation au MAUVAIS nom — surtout dans le
    // premier contact d'une entreprise avec un candidat.
    const mail = buildInterviewEmail({ schedule: scheduleOf(OK.toISOString()) });
    expect(mail.body.startsWith('Bonjour,')).toBe(true);
    expect(mail.body).not.toContain('undefined');

    // Une chaîne vide ou blanche vaut absence, pas « Bonjour   , ».
    expect(
      buildInterviewEmail({ schedule: scheduleOf(OK.toISOString()), candidateName: '  ' }).body,
    ).toContain('Bonjour,');
  });

  it('OMET la demande de confirmation quand aucune adresse ne peut la recevoir', () => {
    // ⚠️ C'est le cœur du choix : `NOTIFICATION_FROM` vaut `noreply@kisso.com` et personne ne
    // le lit. Promettre une réponse à un puits est la famille de mensonge que ce dépôt traque.
    const mail = buildInterviewEmail(base);
    expect(mail.body).not.toContain('confirmer');
  });

  it('adresse la confirmation au DEMANDEUR quand il a une adresse', () => {
    const mail = buildInterviewEmail({ ...base, replyTo: 'karyl@kisso.com' });
    expect(mail.body).toContain('confirmer votre présence en écrivant à karyl@kisso.com');
  });

  it('n’émet AUCUNE prose venue du modèle', () => {
    // Garde-fou de fond : le corps est intégralement produit par ce gabarit. Les seules
    // valeurs variables sont des champs bornés. Un `body` libre serait une primitive
    // d'exfiltration — c'est le scénario que cite `outbound-tool-quarantine.ts`.
    const mail = buildInterviewEmail({
      ...base,
      candidateName: 'Jean Dupont',
      position: 'Dév',
      location: 'Abidjan',
    });
    const attendu = [
      'Bonjour',
      'Nous avons le plaisir',
      'Date :',
      'Lieu :',
      'À bientôt,',
      "L'équipe Kisso Industries",
    ];
    for (const fragment of attendu) expect(mail.body).toContain(fragment);
    // Rien d'autre que les champs et le gabarit : pas de section libre.
    expect(mail.body.split('\n').filter((l) => l.trim()).length).toBeLessThanOrEqual(8);
  });
});

describe('checkInterviewLocation — REFUSER, et non retirer', () => {
  it('laisse passer une adresse physique', () => {
    expect(checkInterviewLocation('Cocody, Abidjan — 2e étage')).toEqual({ ok: true });
    expect(checkInterviewLocation(undefined)).toEqual({ ok: true });
  });

  it('laisse passer les visios connues', () => {
    expect(checkInterviewLocation('https://meet.google.com/abc-defg-hij').ok).toBe(true);
    expect(checkInterviewLocation('https://kisso.zoom.us/j/123').ok).toBe(true);
  });

  it('REFUSE un domaine inconnu, et le NOMME', () => {
    // Refus et non retrait : un email qui convoque « à [lien retiré] » est activement
    // nuisible, là où un message Slack amputé de son lien reste utile.
    const out = checkInterviewLocation('https://evil.example/steal');
    expect(out).toEqual({ ok: false, reason: 'link_domain_not_allowed', host: 'evil.example' });
  });

  it('trouve une URL ENFOUIE dans du texte, pas seulement en préfixe', () => {
    // Ne tester que le début de la chaîne laisserait passer exactement ce cas.
    const out = checkInterviewLocation('Visio : https://evil.example/x (lien Teams)');
    expect(out.ok).toBe(false);
  });

  it('n’est pas contournable par la casse ni par un sous-domaine trompeur', () => {
    expect(checkInterviewLocation('HTTPS://EVIL.EXAMPLE/x').ok).toBe(false);
    // `meet.google.com.evil.example` ne doit PAS passer : le suffixe est vérifié avec le point.
    expect(checkInterviewLocation('https://meet.google.com.evil.example/x').ok).toBe(false);
    // …mais un vrai sous-domaine autorisé passe.
    expect(checkInterviewLocation('https://eu01.zoom.us/j/1').ok).toBe(true);
  });
});
