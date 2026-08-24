import type { EmailProvider } from '../../domain/ports/providers';
import { ASSISTANT_NAME } from '../../../../shared/assistant-identity';
import { SmtpAdapter } from './smtp.adapter';
import { BrevoAdapter } from './brevo.adapter';

export function createEmailProvider(): EmailProvider {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.NOTIFICATION_FROM;

  if (host && user && pass) {
    return new SmtpAdapter({
      host,
      port: Number(process.env.SMTP_PORT ?? 587),
      user,
      pass,
      from: from || user,
      fromName: ASSISTANT_NAME,
    });
  }

  return new BrevoAdapter(
    process.env.BREVO_API_KEY ?? '',
    from ?? 'noreply@kissohq.com',
    ASSISTANT_NAME,
  );
}
