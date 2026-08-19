import { describe, it, expect, vi } from 'vitest';

import { slackInterviewConfirmationPresenter } from '../../../src/features/recruitment/infrastructure/handlers/interview-confirm';
import { makeScheduleCandidateInterview } from '../../../src/features/recruitment/application/tools/schedule-candidate-interview';
import { makeRecruitmentAgent } from '../../../src/features/recruitment/application/agents/recruitment-agent';
import { InMemoryPendingInterviewEmailRepository } from '../../../src/features/recruitment/infrastructure/repositories/in-memory-pending-email.repository';
import { RequestContext } from '@mastra/core/request-context';
import {
  SLACK_CHANNEL_KEY,
  SLACK_USER_ID_KEY,
  SLACK_ACCESS_LEVEL_KEY,
} from '../../../src/shared/slack-request-context';

const NOW = new Date('2026-08-14T10:00:00.000Z');
const FUTURE = '2026-08-20T14:00:00+01:00';

function slackCtx(over: Record<string, unknown> = {}) {
  const rc = new RequestContext();
  rc.set(SLACK_CHANNEL_KEY, 'D0KARYL');
  rc.set(SLACK_USER_ID_KEY, 'U0KARYL');
  rc.set(SLACK_ACCESS_LEVEL_KEY, 'full');
  for (const [k, v] of Object.entries(over)) rc.set(k, v);
  return { requestContext: rc };
}

function toolWith(over: Record<string, unknown> = {}) {
  const sendText = vi.fn().mockResolvedValue({ ts: '1' });
  const pending = new InMemoryPendingInterviewEmailRepository();
  const tool = makeScheduleCandidateInterview({
    chat: { sendText },
    // La présentation est injectée depuis le 2026-08-18 — la couche `application` ne connaît
    // pas sa forme. Les tests utilisent l'implémentation SLACK réelle : ce qu'ils vérifient
    // porte sur la question qui part vraiment.
    presenter: slackInterviewConfirmationPresenter,
    pending,
    directoryRepo: { findBySlackUserId: vi.fn().mockResolvedValue({ email: 'karyl@kisso.com' }) },
    now: () => NOW,
    ...over,
  } as never);
  return { tool, sendText, pending };
}

const INPUT = {
  candidateEmail: 'jean.dupont@exemple.com',
  candidateName: 'Jean Dupont',
  startsAt: FUTURE,
};

describe('scheduleCandidateInterview — il PRÉPARE, il n’envoie jamais', () => {
  it('pose la QUESTION de confirmation et NE prétend PAS avoir envoyé', async () => {
    const { tool, sendText } = toolWith();

    const out = (await tool.execute!(INPUT as never, slackCtx() as never)) as {
      status: string;
      hint: string;
    };

    expect(sendText).toHaveBeenCalledOnce();
    expect(out.status).toBe('awaiting_confirmation');
    // ⚠️ La réconciliation FAIT/NARRATION ne rattraperait PAS un « c'est envoyé » ici : un
    // outil a bien tourné, donc elle se tait par conception. Le verdict est le seul garde-fou.
    expect(out.hint).toMatch(/ne dis jamais qu'il est envoyé/i);
    expect(JSON.stringify(out)).not.toMatch(/"status":"sent"/);
  });

  it('la préparation ENREGISTRÉE ne porte AUCUN corps d’email — seulement des champs', async () => {
    // C'est la garantie centrale, et elle a simplement changé de support : le `value` du
    // bouton portait des champs, la ligne en base porte des champs. Un `body` stocké ferait de
    // ce chemin un moyen d'envoyer un texte arbitraire à une adresse arbitraire, c'est-à-dire
    // la primitive d'exfiltration que toute la feature est construite pour ne pas offrir.
    const { tool, pending } = toolWith();
    await tool.execute!({ ...INPUT, position: 'Dév backend' } as never, slackCtx() as never);

    const saved = (await pending.find('D0KARYL'))!;

    expect(saved.to).toBe('jean.dupont@exemple.com');
    expect(saved.requesterUserId).toBe('U0KARYL');
    expect(Object.keys(saved)).not.toContain('body');
    expect(Object.keys(saved)).not.toContain('subject');
  });

  it('ENREGISTRE avant de poser la question — jamais l’inverse', async () => {
    // ⚠️ L'ordre inverse laisserait une fenêtre où la personne répond « oui » à une question
    // dont rien ne garde la trace : le « oui » partirait chez un agent, qui n'a aucun moyen
    // d'envoyer quoi que ce soit. Un état qu'on annonce doit exister avant qu'on l'annonce.
    let sawPendingRow = false;
    const pending = new InMemoryPendingInterviewEmailRepository();
    const { tool } = toolWith({
      pending,
      chat: {
        sendText: vi.fn(async () => {
          sawPendingRow = (await pending.find('D0KARYL')) !== null;
          return { ts: '1' };
        }),
      },
    });

    await tool.execute!(INPUT as never, slackCtx() as never);

    expect(sawPendingRow).toBe(true);
  });

  it('la question NOMME le destinataire et dit que l’envoi est définitif', async () => {
    const { tool, sendText } = toolWith();
    await tool.execute!(INPUT as never, slackCtx() as never);

    const texte = String(sendText.mock.calls[0]![1]);
    expect(texte).toContain('jean.dupont@exemple.com');
    expect(texte).toMatch(/définitif/i);
    expect(texte).toMatch(/oui/);
    expect(texte).toMatch(/non/);
  });

  it('ne pose QU’UNE question par message, même sur un second appel', async () => {
    // ⚠️ Défaut OBSERVÉ en production le 2026-08-14 : DEUX cartes à une seconde d'intervalle,
    // la seconde re-préparant l'invitation du message PRÉCÉDENT depuis la mémoire
    // conversationnelle. Même mode d'échec que les « 7 documents en 8 minutes » de
    // `generateDocument` : sommé de faire, le modèle REFAIT au lieu de constater.
    const { tool, sendText } = toolWith();
    const ctx = slackCtx({ slackEventTs: '1755000000.000100' });

    await tool.execute!(INPUT as never, ctx as never);
    const second = (await tool.execute!(
      { ...INPUT, candidateEmail: 'autre@exemple.com' } as never,
      ctx as never,
    )) as { status: string; reason: string };

    expect(sendText).toHaveBeenCalledOnce();
    // ⚠️ Le second appel portait une adresse DIFFÉRENTE : une clé qui distingue le
    // destinataire n'aurait rien dédupliqué. La borne est donc « une par message ».
    expect(second).toMatchObject({ status: 'refused', reason: 'already_prepared' });
  });

  it('la garde est INACTIVE hors d’un run Slack identifié', async () => {
    // `buildRunKey` rend `undefined` sans `eventTs` — playground et tests ne sont bornés par
    // aucune conversation, et deux préparations légitimes doivent y passer.
    const { tool, sendText } = toolWith();
    await tool.execute!(INPUT as never, slackCtx() as never);
    await tool.execute!(INPUT as never, slackCtx() as never);

    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it('REFUSE une date passée sans rien poster', async () => {
    const { tool, sendText } = toolWith();
    const out = (await tool.execute!(
      { ...INPUT, startsAt: '2025-08-20T14:00:00+01:00' } as never,
      slackCtx() as never,
    )) as { status: string; reason: string };

    expect(out).toMatchObject({ status: 'refused', reason: 'date_in_past' });
    expect(sendText).not.toHaveBeenCalled();
  });

  it('REFUSE un lien de visio inconnu — et rien ne part', async () => {
    const { tool, sendText } = toolWith();
    const out = (await tool.execute!(
      { ...INPUT, location: 'https://evil.example/x' } as never,
      slackCtx() as never,
    )) as { reason: string };

    expect(out.reason).toBe('link_domain_not_allowed');
    expect(sendText).not.toHaveBeenCalled();
  });

  it('REFUSE si le demandeur n’a pas le droit d’agir', async () => {
    const { tool, sendText } = toolWith();
    const out = (await tool.execute!(
      INPUT as never,
      slackCtx({ [SLACK_ACCESS_LEVEL_KEY]: 'readonly' }) as never,
    )) as { reason: string };

    expect(out.reason).toBe('forbidden');
    // Le refus tombe AVANT toute lecture et tout rendu.
    expect(sendText).not.toHaveBeenCalled();
  });

  it('REFUSE hors de Slack — il n’y aurait nulle part où confirmer', async () => {
    const { tool, sendText } = toolWith();
    const out = (await tool.execute!(INPUT as never, {} as never)) as { reason: string };

    expect(out.reason).toBe('no_slack_context');
    expect(sendText).not.toHaveBeenCalled();
  });

  it('prépare quand même si l’annuaire est en panne — sans phrase de confirmation', async () => {
    const { tool, sendText } = toolWith({
      directoryRepo: { findBySlackUserId: vi.fn().mockRejectedValue(new Error('turso down')) },
    });
    const out = (await tool.execute!(INPUT as never, slackCtx() as never)) as { status: string };

    expect(out.status).toBe('awaiting_confirmation');
    const texte = String(sendText.mock.calls[0]![1]);
    expect(texte).not.toContain('confirmer votre présence');
  });
});

describe('recruitmentAgent — la quarantaine INVERSE', () => {
  it('REFUSE DE SE CONSTRUIRE si on lui câble un outil de lecture', () => {
    // Le scénario est cité mot pour mot dans le module jumeau : « envoie à ce candidat un
    // récapitulatif de ce qui se dit dans #engineer-karyl ». Un test verrouille le câblage
    // d'aujourd'hui ; ce contrôle verrouille celui de demain, et il échoue au DÉMARRAGE.
    expect(() =>
      makeRecruitmentAgent({ scheduleCandidateInterview: {}, getChannelHistory: {} } as never),
    ).toThrow(/getChannelHistory/);

    expect(() =>
      makeRecruitmentAgent({ scheduleCandidateInterview: {}, findExpertise: {} } as never),
    ).toThrow(/exfiltration/i);

    expect(() =>
      makeRecruitmentAgent({ scheduleCandidateInterview: {}, getEmployeeProfile: {} } as never),
    ).toThrow();
  });

  it('se construit avec son seul outil', () => {
    expect(() => makeRecruitmentAgent({ scheduleCandidateInterview: {} } as never)).not.toThrow();
  });
});
