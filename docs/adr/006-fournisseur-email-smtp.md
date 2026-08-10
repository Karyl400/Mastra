# ADR-006 : Fournisseur Email — Passage de Brevo à SMTP (Gmail)

## Statut
Accepté

## Contexte
L'ADR-004 prévoyait un `EmailAdapter` derrière le port `EmailProvider` ; l'implémentation
retenue jusqu'ici était Brevo (`@getbrevo/brevo`), après un premier passage par Resend.
Aucun email n'est jamais parti en production.

Diagnostic mené jusqu'au bout :

- La clé `BREVO_API_KEY` est **valide** : `GET /v3/account` répond `200` (plan gratuit,
  300 crédits disponibles). Le problème n'est donc ni la clé, ni le câblage, ni le code.
- `POST /v3/smtp/email` répond systématiquement **`403 permission_denied` — *"Your SMTP
  account is not yet activated"***. C'est un blocage au niveau du **compte**, pas de la
  requête : il se produit **même avec l'expéditeur validé `sdan28399@gmail.com`**. Aucune
  modification de configuration ne peut le contourner. L'activation du compte transactionnel
  doit être demandée à Brevo (mesure anti-spam fréquente sur les comptes gratuits neufs) et
  dépend d'un tiers, sans délai garanti.
- Second blocage, indépendant : `NOTIFICATION_FROM=noreply@kisso.com` n'est pas un
  expéditeur validé sur ce compte, et le domaine `kisso.com` n'est pas vérifié.

Le projet a besoin d'envoyer des emails de bienvenue **maintenant**, pour valider le
workflow `employeeOnboarding` de bout en bout.

## Options considérées

1. **Attendre l'activation Brevo.** Zéro travail, mais dépend d'un tiers avec un délai
   inconnu et bloque toute validation end-to-end en attendant. Rejeté comme solution
   immédiate — conservé comme piste parallèle.
2. **Vérifier un domaine (Brevo ou autre).** C'est la bonne réponse à long terme
   (délivrabilité, SPF/DKIM/DMARC, expéditeur `@kisso.com` crédible), mais elle suppose de
   **posséder et administrer le DNS** du domaine. Ce n'est pas le cas aujourd'hui. Reporté.
3. **Revenir à Resend.** Plus strict que Brevo dans notre situation : sans domaine vérifié,
   Resend n'autorise l'envoi que vers **la propre adresse du titulaire du compte**. On ne
   pourrait donc même pas écrire à un employé. L'adaptateur avait déjà été supprimé. Rejeté.
4. **SMTP classique via Gmail (`nodemailer`).** Envoie immédiatement, sans domaine à
   vérifier ni validation d'expéditeur par un tiers. Un compte Gmail existant suffit.
   Retenu.

## Décision
L'implémentation par défaut du port `EmailProvider` devient **`SmtpAdapter`**
(`src/features/notification/infrastructure/providers/smtp.adapter.ts`, basée sur
`nodemailer`). Brevo est conservé en **repli**.

La sélection se fait dans la fonction `createEmailProvider()` de `src/mastra/index.ts`
(seul point de câblage, conformément aux conventions du projet) :

- si `SMTP_HOST`, `SMTP_USER` **et** `SMTP_PASS` sont tous renseignés → `SmtpAdapter` ;
- sinon → `BrevoAdapter`.

Aucun code applicatif ne change : le port `EmailProvider` est inchangé, la bascule est une
décision d'injection de dépendances.

Preuve de fonctionnement : un email réel a été accepté par Gmail (`250 OK`) et délivré.

## Conséquences

**Avantages**
- Envoi réel opérationnel sans dépendre de l'activation d'un compte tiers.
- Aucun domaine à posséder ni à vérifier pour démarrer.
- L'inversion de dépendance de l'ADR-001 est validée en pratique : changer de fournisseur
  email n'a touché que l'infrastructure et le câblage.

**Inconvénients et contraintes à connaître**
- **Mot de passe d'application obligatoire (Gmail).** Google refuse le mot de passe du
  compte pour SMTP depuis mai 2022 :
  `534-5.7.9 Application-specific password required`. Il faut un « App Password » de
  16 caractères, ce qui suppose la validation en deux étapes activée sur le compte.
  `SMTP_PASS` doit contenir **ce** mot de passe, jamais celui du compte.
- **Fragilité en serverless.** SMTP maintient une connexion TCP, contrairement à une API
  HTTP : sur Vercel c'est plus lent et la connexion ne survit pas au gel de la fonction.
  L'adaptateur désactive donc le pool (`pool: false`) et borne les timeouts à 10 s, pour
  échouer vite plutôt que retenir la requête appelante.
- **Quota.** Gmail plafonne aux alentours de **500 destinataires par jour** pour un compte
  gratuit. Suffisant pour de l'onboarding, insuffisant pour du volume.
- **Délivrabilité dégradée.** Un email envoyé depuis une adresse `@gmail.com` au nom de
  « Kisso » est structurellement plus exposé au spam : l'expéditeur ne correspond pas à la
  marque et il n'y a ni SPF ni DKIM propres au domaine. C'est acceptable en phase de
  validation, **pas** en régime permanent — le correctif propre reste l'option 2
  (domaine vérifié, expéditeur `@kisso.com`), et l'`SmtpAdapter` fonctionnera tel quel avec
  le SMTP de ce domaine.
- **L'échec d'envoi reste silencieux.** L'étape `sendWelcomeEmail` capture l'erreur et pose
  `emailSent: false`, mais le workflow retourne quand même `status: 'success'`. Ce piège
  n'est pas résolu par le changement de fournisseur : ne jamais conclure qu'un email est
  parti sans vérifier `emailSent`.
- `BREVO_API_KEY` doit rester déployée tant que le repli Brevo existe, alors qu'il ne peut
  rien envoyer aujourd'hui — à supprimer le jour où le repli est retiré.
