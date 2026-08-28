import { ESCALATION_CONTACT, ESCALATION_CONTACT_EN } from './escalation';
import { EMERGENCY_LINES } from './emergency-lines';

const CRISIS = EMERGENCY_LINES.crisis;
const MEDICAL = EMERGENCY_LINES.medical;

export const DISTRESS_REPLY =
  "Merci de me l'avoir dit. Je ne suis pas la bonne personne pour t'aider là-dessus, et je ne " +
  'vais pas te laisser sans réponse.\n\n' +
  `Si c'est urgent : *${CRISIS.number}* (${CRISIS.label}), ou le *${MEDICAL.number}* ` +
  `(${MEDICAL.label}) si la vie de quelqu'un est en jeu maintenant.\n` +
  `Et si tu préfères en parler à quelqu'un d'ici : ${ESCALATION_CONTACT}, ou quelqu'un en qui ` +
  'tu as confiance dans le workspace.\n\n' +
  "Je n'ai transmis ce message à personne : il reste entre nous.";

export const DISTRESS_REPLY_EN =
  "Thank you for telling me. I'm not the right person to help you with this, and I won't leave " +
  'you without an answer.\n\n' +
  `If it's urgent: *${CRISIS.number}* (${CRISIS.labelEn}), or *${MEDICAL.number}* ` +
  `(${MEDICAL.labelEn}) if someone's life is at risk right now.\n` +
  `And if you'd rather talk to someone here: ${ESCALATION_CONTACT_EN}, or anyone you trust in ` +
  'the workspace.\n\n' +
  "I haven't passed this message on to anyone: it stays between us.";

export const AGGRESSION_REPLY =
  "Ce que tu me décris n'a rien de normal, et tu as bien fait de le dire.\n\n" +
  `Si tu es en danger tout de suite : *${CRISIS.number}* (${CRISIS.label}). Le ` +
  `*${MEDICAL.number}* (${MEDICAL.label}) pour une urgence médicale.\n` +
  `Pour ce qui se passe au travail — harcèlement, menaces, discrimination — parles-en à ` +
  `${ESCALATION_CONTACT}. C'est lui qui peut agir là-dessus, pas moi.\n\n` +
  "Je n'ai transmis ce message à personne : il reste entre nous.";

export const AGGRESSION_REPLY_EN =
  "What you're describing is not normal, and you were right to say it.\n\n" +
  `If you're in danger right now: *${CRISIS.number}* (${CRISIS.labelEn}). ` +
  `*${MEDICAL.number}* (${MEDICAL.labelEn}) for a medical emergency.\n` +
  `For what's happening at work — harassment, threats, discrimination — talk to ` +
  `${ESCALATION_CONTACT_EN}. He's the one who can act on it, not me.\n\n` +
  "I haven't passed this message on to anyone: it stays between us.";
