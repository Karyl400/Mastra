import { describe, it, expect, vi } from 'vitest';

import { makeScheduleCandidateInterview } from '../../../src/features/recruitment/application/tools/schedule-candidate-interview';
import { confirmPendingEmail } from '../../../src/features/recruitment/application/services/confirm-pending-email';
import { InMemoryPendingInterviewEmailRepository } from '../../../src/features/recruitment/infrastructure/repositories/in-memory-pending-email.repository';
import { slackInterviewConfirmationPresenter } from '../../../src/features/recruitment/infrastructure/handlers/interview-confirm';
import { buildSlackRequestContext } from '../../../src/shared/slack-request-context';

/**
 * Décision du propriétaire, 2026-10-16 : SEUL le General Manager recrute — et il ne doit perdre
 * AUCUNE de ses capacités. Ce test rejoue sa chaîne de bout en bout après les lots du jour
 * (second verrou `no_requester` sur les outils agissants, échéance partagée, réécriture de
 * l'instruction de `recruitmentAgent`) : préparer, y mettre un lien Google Meet, confirmer par
 * « oui », et l'email part RÉELLEMENT vers le transport. Et quiconque d'autre reste refusé.
 */

const NOW = new Date('2026-10-16T10:00:00.000Z');
const MANAGER = 'UMLK5P7CG';
const DM = 'D0NAZER01';
const MEET = 'https://meet.google.com/abc-defg-hij';

const as = (slackUserId: string, accessLevel: 'full' | 'readonly') => ({
  requestContext: buildSlackRequestContext({
    channel: DM,
    slackUserId,
    eventTs: '1792170000.000100',
    accessLevel,
  }),
});

function setup() {
  const pending = new InMemoryPendingInterviewEmailRepository();
  const sendText = vi.fn().mockResolvedValue({ ts: '1' });
  const tool = makeScheduleCandidateInterview({
    chat: { sendText },
    presenter: slackInterviewConfirmationPresenter,
    pending,
    directoryRepo: { findBySlackUserId: vi.fn().mockResolvedValue({ email: 'nazer@kissohq.com' }) },
    now: () => NOW,
  } as never);
  return { tool, pending, sendText };
}

const INPUT = {
  candidateEmail: 'jean.dupont@exemple.com',
  candidateName: 'Jean Dupont',
  startsAt: '2026-10-22T14:00:00+01:00',
  position: 'Développeur backend',
  location: MEET,
};

describe('le General Manager garde TOUTE la chaîne de recrutement', () => {
  it('prépare l’invitation avec un lien Google Meet, puis l’ENVOIE sur son « oui »', async () => {
    const { tool, pending, sendText } = setup();

    const prepared = (await tool.execute!(INPUT as never, as(MANAGER, 'full') as never)) as {
      status: string;
    };
    expect(prepared.status).toBe('awaiting_confirmation');
    expect(sendText).toHaveBeenCalledOnce();

    const stored = await pending.find(DM);
    expect(stored?.location).toBe(MEET);
    expect(stored?.requesterUserId).toBe(MANAGER);

    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const outcome = await confirmPendingEmail(
      { pending, sendEmail, now: () => NOW },
      stored!,
      MANAGER,
    );

    expect(outcome.kind).toBe('sent');
    expect(sendEmail).toHaveBeenCalledOnce();
    const [to, subject, body] = sendEmail.mock.calls[0]!;
    expect(to).toBe('jean.dupont@exemple.com');
    expect(String(subject)).toMatch(/entretien/i);
    expect(JSON.stringify(body)).toContain(MEET);
    expect(await pending.find(DM)).toBeNull();
  });

  it('accepte aussi Zoom et Teams — la liste blanche de visio est intacte', async () => {
    for (const link of [
      'https://zoom.us/j/123456789',
      'https://teams.microsoft.com/l/meetup-join/x',
    ]) {
      const { tool } = setup();
      const out = (await tool.execute!(
        { ...INPUT, location: link } as never,
        as(MANAGER, 'full') as never,
      )) as { status: string };
      expect(out.status).toBe('awaiting_confirmation');
    }
  });

  it('un salarié qui n’est pas le manager reste refusé, avant toute préparation', async () => {
    const { tool, sendText, pending } = setup();

    const out = (await tool.execute!(INPUT as never, as('U0BJBDGTJUD', 'readonly') as never)) as {
      reason: string;
    };

    expect(out.reason).toBe('forbidden');
    expect(sendText).not.toHaveBeenCalled();
    expect(await pending.find(DM)).toBeNull();
  });

  it('le « oui » d’un AUTRE que le manager n’envoie rien', async () => {
    const { tool, pending } = setup();
    await tool.execute!(INPUT as never, as(MANAGER, 'full') as never);

    const sendEmail = vi.fn();
    const outcome = await confirmPendingEmail(
      { pending, sendEmail, now: () => NOW },
      (await pending.find(DM))!,
      'U0BJBDGTJUD',
    );

    expect(outcome.kind).toBe('not_yours');
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
