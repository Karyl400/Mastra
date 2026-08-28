import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('llm-system-prompt');

export const encryptionDuration = meter.createHistogram('prompt.encryption.duration', {
  description: 'Durée des opérations de chiffrement',
  unit: 'ms',
});

export const decryptionDuration = meter.createHistogram('prompt.decryption.duration', {
  description: 'Durée des opérations de déchiffrement',
  unit: 'ms',
});

export const sessionCounter = meter.createCounter('prompt.session.count', {
  description: 'Nombre de sessions actives',
});

export const injectionCounter = meter.createCounter('prompt.injection.detected', {
  description: "Nombre de tentatives d'injection détectées",
});

export function measureDuration<T>(
  histogram: ReturnType<typeof meter.createHistogram>,
  operation: () => T,
): T {
  const start = Date.now();
  try {
    return operation();
  } finally {
    histogram.record(Date.now() - start);
  }
}
