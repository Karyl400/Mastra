export interface ArchivedMessage {
  readonly id: string;
  readonly channelId: string;
  readonly slackUserId: string | null;
  readonly text: string;
  readonly threadTs: string | null;
  readonly postedAt: number;
}

export interface MessageArchiveRepository {
  archive(message: ArchivedMessage): Promise<boolean>;
  search(query: string, options?: MessageSearchOptions): Promise<readonly ArchivedMessage[]>;
  forgetUser(slackUserId: string): Promise<number>;
  prune(before: number): Promise<number>;
}

export interface MessageSearchOptions {
  readonly channelId?: string;
  readonly slackUserId?: string;
  readonly limit?: number;
}

/**
 * ⚠️ **LES DM SONT ARCHIVÉS DEPUIS LE 2026-08-21, ET CE N'EST PAS UN DÉTAIL DE PLUS.**
 *
 * `im` était délibérément absent : n'archiver que les canaux revenait à ne garder que ce qui
 * était déjà public pour ses membres. Un DM, lui, est un espace privé — et
 * `authorizeOtherMemoryRead` autorise le manager à chercher ce qu'une AUTRE personne a dit.
 *
 * **Conséquence assumée, décidée par le propriétaire** : le General Manager peut relire ce que
 * chacun écrit en privé à Marcel. La portée d'un DM devient celle d'un canal. C'est un choix de
 * produit, pas un effet de bord — et il est écrit ici pour qu'il ne se redécouvre pas un jour
 * par surprise.
 *
 * ⚠️ Deux garde-fous restent en place et ne doivent PAS être relâchés au motif que les DM
 * entrent : `forgetUser` emporte l'archive d'une personne (c'est le droit à l'effacement, pas
 * un privilège), et `mpim` reste ABSENT — un groupe privé de plusieurs personnes n'a ni
 * l'appartenance vérifiable d'un canal, ni le propriétaire unique d'un DM.
 */
export const ARCHIVED_CHANNEL_TYPES: readonly string[] = ['channel', 'group', 'im'];

export function isArchivableChannelType(channelType: string | undefined): boolean {
  return channelType !== undefined && ARCHIVED_CHANNEL_TYPES.includes(channelType);
}

/** Un canal de DM : `D…`. Slack ne dit pas « je suis membre » d'un DM comme d'un canal. */
export function isDirectMessageChannel(channelId: string): boolean {
  return /^D/i.test(channelId.trim());
}

export function archiveIdOf(channelId: string, ts: string): string {
  return `${channelId}:${ts}`;
}

export function postedAtOf(ts: string): number {
  const seconds = Number.parseFloat(ts);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}
