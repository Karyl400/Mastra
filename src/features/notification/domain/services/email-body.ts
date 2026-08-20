export interface EmailBody {
  readonly html: string;
  readonly text: string;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripTags(html: string): string {
  return (
    html
      // eslint-disable-next-line sonarjs/super-linear-regex
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function htmlEmailBody(html: string): EmailBody {
  return { html, text: stripTags(html) };
}

export function textEmailBody(plain: string): EmailBody {
  return {
    html: escapeHtml(plain).replace(/\n/g, '<br />\n'),
    text: plain,
  };
}
