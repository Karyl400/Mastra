import type { MetricSpec } from '../value-objects/metric';

export const HEALTH_METRICS: readonly MetricSpec[] = [
  {
    key: 'health.notificationFailure',
    family: 'health',
    label: 'Taux d’échec d’envoi',
    unit: 'percent',
    source: {
      derived: true,
      from: ["notifications.status='failed'"],
      caveat:
        'Couvre les emails et rappels, pas la publication d’un message Slack : un ' +
        '`chat.postMessage` en `not_in_channel` échoue SILENCIEUSEMENT pour l’utilisateur — le ' +
        'message d’erreur de repli est posté dans le même canal inaccessible, donc échoue aussi.',
    },
  },
  {
    key: 'health.documentDelivery',
    family: 'health',
    label: 'Documents réellement livrés',
    unit: 'percent',
    source: {
      derived: true,
      from: ["documents.status='sent'"],
      caveat:
        'Le document est TOUJOURS enregistré, même quand la livraison échoue ; seule une ' +
        'livraison réussie pose `sent`. L’écart entre les deux EST la mesure.',
    },
  },
  {
    key: 'health.errors',
    family: 'health',
    label: 'Refus et erreurs (24 h)',
    unit: 'count',
    source: {
      derived: true,
      from: ["audit_logs (status='failure' | 'denied')"],
      caveat:
        'Ne couvre que ce que le handler journalise — `RATE_LIMITED`, `AUTHZ_DENIED`, ' +
        '`SLACK_MESSAGE`. Une exception levée dans un outil n’apparaît pas ici.',
    },
  },
  {
    key: 'health.rateLimited',
    family: 'health',
    label: 'Messages refusés au quota (24 h)',
    unit: 'count',
    source: { derived: true, from: ["audit_logs (action='RATE_LIMITED')"] },
  },
  {
    key: 'health.uptime',
    family: 'health',
    label: 'Disponibilité',
    unit: 'percent',
    source: {
      derived: false,
      gap: 'external_owner',
      because:
        'Une fonction serverless ne peut pas mesurer sa propre disponibilité : quand elle est ' +
        'indisponible, elle ne tourne pas, donc elle n’écrit rien. Un « 100 % » calculé depuis ' +
        'l’intérieur ne dit qu’une chose — que le calcul a pu tourner.',
      wouldTake:
        'Une sonde EXTÉRIEURE (Vercel Observability, ou un ping externe). La mesure appartient ' +
        'à la plateforme, pas au produit ; l’afficher ici la fabriquerait.',
    },
  },
];
