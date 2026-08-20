/* eslint-disable security/detect-unsafe-regex */
const SLACK_LINK = /<(mailto:|https?:\/\/|tel:)([^|>]{0,2000})(?:\|([^|>]{0,2000}))?>/gu;

export function unwrapSlackLinks(raw: string | undefined | null): string {
  return (raw ?? '').replace(
    SLACK_LINK,
    (_match, scheme: string, target: string, label?: string) =>
      scheme === 'mailto:' ? target : (label ?? target),
  );
}
