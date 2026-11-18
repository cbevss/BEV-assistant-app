/**
 * Just enough Markdown for BEV's replies: paragraphs, bullet and numbered
 * lists, **bold**, *italic*, `code`, fenced code and links. Builds React
 * elements directly, so no HTML from a reply is ever injected.
 */
import { Fragment, ReactNode } from "react";

function openLink(href: string) {
  import("@tauri-apps/plugin-shell").then(({ open }) => open(href)).catch(() => window.open(href, "_blank"));
}

export function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1]) out.push(<code key={k} className="rounded-sm bg-surface-3 px-1 py-px font-mono text-[0.92em] text-ink">{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k} className="font-semibold text-ink">{m[2].slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={k}>{m[3].slice(1, -1)}</em>);
    else {
      const href = m[5] ?? m[6];
      const label = m[4] ? m[4].slice(1, m[4].indexOf("]")) : href;
      out.push(
        <a
          key={k}
          href={href}
          onClick={(e) => {
            e.preventDefault();
            openLink(href);
          }}
          className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
        >
          {label}
        </a>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  let b = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={b++} className="overflow-x-auto rounded bg-surface-2 px-3 py-2 font-mono text-xs leading-5 text-ink-2">
          {code.join("\n")}
        </pre>
      );
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
      const L = ordered ? "ol" : "ul";
      blocks.push(
        <L key={b++} className={ordered ? "list-decimal space-y-1 pl-5 marker:text-ink-3" : "list-disc space-y-1 pl-5 marker:text-ink-4"}>
          {items.map((t, j) => (
            <li key={j}>{inline(t, `${b}-${j}`)}</li>
          ))}
        </L>
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith("```") && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) para.push(lines[i++].replace(/^#{1,6}\s+/, ""));
    blocks.push(
      <p key={b++}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(p, `${b}-${j}`)}
          </Fragment>
        ))}
      </p>
    );
  }
  return <div className="space-y-2.5">{blocks}</div>;
}
