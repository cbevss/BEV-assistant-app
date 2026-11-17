/** Turn a fetched web page into readable text for the AI. Pure; tested. */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", mdash: "—", ndash: "–", hellip: "…", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

export interface PageText {
  title: string;
  text: string;
  truncated: boolean;
}

export function pageText(html: string, contentType = "text/html", max = 12_000): PageText {
  if (!/html|xml/i.test(contentType) && !/<html|<body|<p[\s>]/i.test(html.slice(0, 2000))) {
    const t = html.trim();
    return { title: "", text: t.slice(0, max), truncated: t.length > max };
  }
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim());
  // Prefer the main content when the page marks it.
  const main = /<(main|article)[^>]*>([\s\S]*?)<\/\1>/i.exec(html)?.[2] ?? html;
  let t = main
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|header|footer|form|iframe|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<h[1-6][^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");
  t = decode(t)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l, i, a) => l || (a[i - 1] ?? "") !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: t.slice(0, max), truncated: t.length > max };
}
