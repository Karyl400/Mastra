export type DeliveryVerdict = 'slack' | 'email' | 'none' | 'failed';

export const HINTS = {
  document_not_found:
    "Aucun document de ce type n'existe encore pour cette personne : RIEN n'a été corrigé et " +
    "rien n'a été créé. Ne prétends pas avoir corrigé. Rappelle le tool sans `revises` pour " +
    'en produire un.',
  employee_not_found:
    "Aucun employé ne porte cet identifiant : rien n'a été généré. Ne l'invente pas, demande " +
    "l'email de la personne et passe par findEmployeeByEmail.",
  no_slack_context:
    "Aucun canal Slack connu ici : le document est enregistré mais n'a été envoyé nulle part. " +
    'Dis-le, ne promets aucun envoi.',
  missing_scope:
    "Le bot n'a pas le droit d'envoyer des fichiers dans Slack : document enregistré, non livré. " +
    'Dis-le simplement, sans lien ni pièce jointe promise.',
  no_email:
    'Aucune adresse email connue pour cet employé : document enregistré, non envoyé. Dis-le.',
  delivery_failed:
    "L'envoi a échoué : le document est prêt et enregistré, mais non livré. Dis-le, et ne " +
    'propose aucun lien de téléchargement.',
  not_rendered:
    "Aucun fichier n'a pu être produit : seul le texte est enregistré. Dis que le document " +
    "existe mais qu'aucun fichier n'a été envoyé.",
  not_authorized:
    "Tu n'as pas le droit de produire un document au nom de cette personne. Dis-le simplement, " +
    'sans inventer de motif. Ne réessaie pas avec un autre outil et ne reformule pas la demande.',
} as const;

export type HintKey = keyof typeof HINTS;

export type DeliveryIntent = 'slack' | 'email' | 'none';

export interface DeliveryOutcome {
  delivery: DeliveryVerdict;
  reason: HintKey | undefined;
}

export const NO_SUBJECT_RESULT = {
  saved: false as const,
  delivery: 'none' as DeliveryVerdict,
  reason: 'employee_not_found' as const,
  hint: HINTS.employee_not_found,
};
