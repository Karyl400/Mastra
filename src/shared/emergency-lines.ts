/**
 * ⚠️ LE SEUL FICHIER DU DÉPÔT OÙ UNE ERREUR PEUT COÛTER UNE VIE.
 *
 * Règle absolue, héritée du correctif du 2026-08-18 : **ne jamais écrire ici un numéro qu'on
 * n'a pas vérifié auprès d'une source nommée.** Un numéro faux consomme le seul geste que la
 * personne aura peut-être la force de faire. À défaut de vérification, le texte oriente vers
 * un humain SANS donner de numéro — c'est moins bien, ce n'est pas dangereux.
 *
 * Ce module existe parce que la règle ne tenait qu'à un commentaire. Elle tient désormais à
 * une STRUCTURE : chaque numéro porte sa source dans le champ `verified`, et il faut mentir
 * dans ce champ pour introduire un numéro non vérifié.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TROIS NUMÉROS ONT ÉTÉ ÉCARTÉS PENDANT LA VÉRIFICATION DU 2026-08-21, et chacun aurait été
 * une faute plausible :
 *
 *   • **3114** — français. Il figurait ici jusqu'au 2026-08-18 et ne joignait personne.
 *   • **122** — congolais (RDC). Il remonte en tête d'une recherche « ligne verte violences
 *     basées sur le genre » parce que trois médias congolais en parlent ; aucune source
 *     béninoise ne le cite.
 *   • **143** — ivoirien. C'est la ligne nationale d'assistance psychologique de Côte
 *     d'Ivoire, annoncée par un ministère dont le sigle (MSHPCMU) ressemble à s'y méprendre
 *     à celui d'un ministère béninois.
 *
 * Les trois sont réels, gratuits, et joignent quelqu'un — dans un AUTRE pays. C'est
 * exactement pourquoi une recherche rapide ne suffit pas ici : la mauvaise réponse a toutes
 * les apparences de la bonne.
 *
 * Le **138** béninois est réel et vérifié, mais il est délibérément ABSENT : c'est la ligne
 * d'assistance aux ENFANTS victimes de violences (UNICEF Bénin). La citer à un salarié
 * adulte l'enverrait vers un service qui ne peut pas le prendre en charge.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type EmergencyCountry = 'BJ' | 'NG';

export interface EmergencyLine {
  /** Le numéro, tel qu'il doit être composé. */
  readonly number: string;
  /** Ce qu'on joint — en français, dans la phrase. */
  readonly label: string;
  readonly labelEn: string;
  /** ⚠️ La source qui l'établit. Un numéro sans source n'entre pas dans cette table. */
  readonly verified: string;
}

export interface EmergencyLines {
  readonly country: EmergencyCountry;
  /** Ce qu'on compose quand quelqu'un est en danger immédiat, ou pense à en finir. */
  readonly crisis: EmergencyLine;
  /** L'urgence médicale. */
  readonly medical: EmergencyLine;
}

const BENIN: EmergencyLines = {
  country: 'BJ',
  crisis: {
    number: '117',
    label: 'Police Républicaine, gratuit, 24h/24 partout au Bénin',
    labelEn: 'Police Républicaine, free, 24/7 anywhere in Benin',
    // Deux angles indépendants, ce qui est ce qui fait la force de ce numéro-ci :
    //  1. Police Républicaine du Bénin — numéro vert gratuit, centre d'appels ouvert le
    //     2026-11-07 (couvert par banouto.bj, beninwebtv.bj, lanouvelletribune.info,
    //     cappfm.com, mediapartbenin.bj), et repris dans la liste officielle des numéros
    //     courts publiée par l'ARCEP Bénin.
    //  2. `findahelpline.com/countries/bj` le liste comme « Benin Emergency Hotline »,
    //     service 24h/24 pour toute personne en situation d'urgence OU en risque suicidaire.
    // C'est le second point qui décide : il couvre les deux cas de ce module.
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

/**
 * ⚠️ LE DÉFAUT EST LE BÉNIN, ET CE CHOIX MÉRITE D'ÊTRE EXPLIQUÉ PLUTÔT QUE SUBI.
 *
 * `CLAUDE.md` a consigné le 2026-08-18 que les salariés sont au Nigeria, et le message de
 * détresse citait donc SURPIN. Le propriétaire a demandé le 2026-08-21 des numéros locaux en
 * nommant la **police béninoise**. Les deux affirmations viennent de la même personne et se
 * contredisent ; la plus récente et la plus explicite l'emporte.
 *
 * Le Nigeria n'est pas supprimé pour autant — ses numéros restent vérifiés et disponibles par
 * `EMERGENCY_COUNTRY=NG`. Trancher en supprimant l'autre pays aurait détruit une vérification
 * qui avait coûté cher, pour un gain nul.
 *
 * Une valeur inconnue retombe sur le défaut plutôt que de lever : une faute de frappe dans une
 * variable d'environnement ne doit pas priver quelqu'un de tout numéro. Même arbitrage que
 * `readRuleLimit`, qui refuse une limite à 0.
 */
export function resolveEmergencyLines(env: NodeJS.ProcessEnv = process.env): EmergencyLines {
  const raw = env.EMERGENCY_COUNTRY?.trim().toUpperCase();
  if (raw === 'NG') return NIGERIA;
  if (raw === 'BJ') return BENIN;
  return BENIN;
}

export const EMERGENCY_LINES = resolveEmergencyLines();

export const ALL_EMERGENCY_LINES: readonly EmergencyLines[] = Object.values(LINES_BY_COUNTRY);
