export type EmergencyCountry = 'BJ' | 'NG';

export interface EmergencyLine {
  readonly number: string;
  readonly label: string;
  readonly labelEn: string;
  readonly verified: string;
}

export interface EmergencyLines {
  readonly country: EmergencyCountry;
  readonly crisis: EmergencyLine;
  readonly medical: EmergencyLine;
}

const BENIN: EmergencyLines = {
  country: 'BJ',
  crisis: {
    number: '117',
    label: 'Police Républicaine, gratuit, 24h/24 partout au Bénin',
    labelEn: 'Police Républicaine, free, 24/7 anywhere in Benin',
    verified: 'ARCEP Bénin + Police Républicaine (numéro vert) + findahelpline.com/countries/bj',
  },
  medical: {
    number: '112',
    label: 'SAMU',
    labelEn: 'SAMU, medical emergencies',
    verified: 'ARCEP Bénin — liste officielle des numéros courts d’urgence',
  },
};

const NIGERIA: EmergencyLines = {
  country: 'NG',
  crisis: {
    number: '0800 0787 746',
    label: 'SURPIN, gratuit, 24h/24, partout au Nigeria',
    labelEn: 'SURPIN, free, 24/7, anywhere in Nigeria',
    verified: 'LifeLine International + findahelpline.com/countries/ng — vérifié le 2026-08-18',
  },
  medical: {
    number: '112',
    label: 'urgences nationales',
    labelEn: 'national emergency line',
    verified: 'Numéro d’urgence national nigérian — vérifié le 2026-08-18',
  },
};

const LINES_BY_COUNTRY: Readonly<Record<EmergencyCountry, EmergencyLines>> = {
  BJ: BENIN,
  NG: NIGERIA,
};

export function resolveEmergencyLines(env: NodeJS.ProcessEnv = process.env): EmergencyLines {
  const raw = env.EMERGENCY_COUNTRY?.trim().toUpperCase();
  if (raw === 'NG') return NIGERIA;
  if (raw === 'BJ') return BENIN;
  return BENIN;
}

export const EMERGENCY_LINES = resolveEmergencyLines();

export const ALL_EMERGENCY_LINES: readonly EmergencyLines[] = Object.values(LINES_BY_COUNTRY);
