import { Marked } from 'marked';

export interface ManualSection {
  id: string;
  title: string;
}

/** GitHub's heading anchor rule, so links in docs/MANUAL.md work on GitHub and on the site. */
export function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

/**
 * Render the manual to HTML. Headings get GitHub-style ids, images are
 * resolved against `imageBase`, and the level 2 headings become the table of
 * contents.
 */
export function renderManual(markdown: string, imageBase = 'docs/'): { html: string; sections: ManualSection[] } {
  const sections: ManualSection[] = [];
  const used = new Map<string, number>();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const base = slug(plain(inner));
        const n = used.get(base) ?? 0;
        used.set(base, n + 1);
        const id = n ? `${base}-${n}` : base;
        if (depth === 2) sections.push({ id, title: plain(inner) });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inner}</h${depth}>\n`;
      },
      image({ href, title, text }) {
        const src = /^[a-z]+:|^\//i.test(href) ? href : imageBase + href;
        const t = title ? ` title="${title}"` : '';
        return `<img src="${src}" alt="${text}"${t} loading="lazy">`;
      },
    },
  });
  const html = marked
    .parse(markdown, { async: false })
    // Wide tables scroll on their own instead of widening the page on phones.
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>');
  // The manual's own contents list is replaced by the navigation of the page.
  const withoutToc = html.replace(/<h2 id="contents">[\s\S]*?(?=<h2 )/, '');
  return { html: withoutToc, sections: sections.filter((s) => s.id !== 'contents') };
}
