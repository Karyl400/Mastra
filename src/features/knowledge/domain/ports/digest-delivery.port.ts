export interface ChannelDigest {
  readonly channelId: string;
  readonly title: string;
  readonly coverage: string;
  readonly lines: readonly string[];
}

export interface DigestTarget {
  readonly channel: string;
  readonly threadTs?: string;
}

export type DigestDeliveryVerdict =
  | { readonly delivered: true; readonly filename: string }
  | { readonly delivered: false; readonly reason: 'not_rendered' | 'post_failed' };

export interface DigestDeliveryPort {
  deliver(digest: ChannelDigest, target: DigestTarget): Promise<DigestDeliveryVerdict>;
}
