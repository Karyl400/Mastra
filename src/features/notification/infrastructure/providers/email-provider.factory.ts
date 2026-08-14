import type { EmailProvider } from '../../domain/ports/providers';
import { SmtpAdapter } from './smtp.adapter';
import { BrevoAdapter } from './brevo.adapter';

/**
 * Sélection du fournisseur email — UN SEUL endroit.
 *
 * ⚠️ Cette fonction vivait dans `src/mastra/index.ts`. Elle en a été EXTRAITE le 2026-08-14
 * parce que `src/api/slack-interactions.route.ts` en a désormais besoin lui aussi — c'est là
 * qu'un email d'entretien part réellement, au clic sur « Envoyer » — et que la route ne peut
 * pas importer `index.ts` : celui-ci importe la route, le cycle serait immédiat.
 *
 * L'alternative était de recopier le choix SMTP/Brevo dans la route. Ce dépôt a déjà payé
 * trois fois le prix d'une décision dupliquée qui diverge (`WIRING` dans deux fichiers,
 * `_measure.mts`, les instructions nommant des tools retirés) : ici, une divergence ferait
 * partir les emails d'entretien par un fournisseur et ceux de notification par un autre,
 * sans que rien ne le signale.
 *
 * SMTP l'emporte dès que `SMTP_HOST`, `SMTP_USER` et `SMTP_PASS` sont tous renseignés, sinon
 * on retombe sur Brevo. Raison : le compte transactionnel Brevo n'est PAS activé
 * (`403 permission_denied` sur `POST /v3/smtp/email`, y compris avec un expéditeur validé),
 * donc SMTP est aujourd'hui le seul chemin qui envoie réellement.
 *
 * ⚠️ Gmail : `SMTP_PASS` doit être un mot de passe d'APPLICATION (16 caractères), pas le mot
 * de passe du compte — sinon `534-5.7.9 Application-specific password required`.
 */
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
      fromName: 'Kisso Onboarding',
    });
  }

  return new BrevoAdapter(process.env.BREVO_API_KEY ?? '', from ?? 'noreply@kissohq.com');
}
