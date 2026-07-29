# ADR-004 : Stratégie de Notifications

## Statut
Accepté

## Contexte
La communication avec l'employé et le manager est primordiale durant l'onboarding. Les messages doivent être personnalisés, au bon format et envoyés via le bon canal (Email, Slack, In-app).

## Décision
Toutes les notifications sont gérées de manière centralisée par le **NotificationAgent** et son workflow associé (`NotificationCycle`).

### Composants
1. **Agent IA** : Le NotificationAgent est responsable de formater le message (ton, langage) en fonction du destinataire et du contexte.
2. **Outils d'envoi (Ports/Adapters)** :
   - `EmailAdapter` : pour l'envoi de mails (via SMTP).
   - `SlackAdapter` : pour envoyer des messages sur un channel ou en message direct.
   - `InAppAdapter` : pour créer une notification dans la base de données qui sera lue par le frontend de l'employé.
3. **Planification** : L'outil `scheduleReminder` permet de différer une notification. (Implémentation via des tâches planifiées ou un polling de la base de données).

## Conséquences
- **Avantages** : L'intelligence de la rédaction et du choix du canal est déléguée à l'agent IA, rendant les interactions plus humaines.
- **Inconvénients** : La dépendance au LLM pour toutes les notifications peut introduire une latence (cependant, cela peut être fait de manière asynchrone).
