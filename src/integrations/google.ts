/** Google: Gmail (search, read, draft; never sends) and Calendar. */
import type { RegisteredTool } from "@/ai/tools";
import { native } from "@/lib/native";
import { useSettings } from "@/state/settings";
import { api } from "./http";
import { accessToken, type OAuthConfig } from "./oauth";
import { str, optStr, clip } from "./args";

export const GOOGLE_SECRET = "google_client_secret";

export async function googleOAuth(): Promise<OAuthConfig> {
  return {
    id: "google",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId: useSettings.getState().settings.integrations.google.clientId,
    clientSecret: (await native.getSecret(GOOGLE_SECRET).catch(() => null)) ?? undefined,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose", "https://www.googleapis.com/auth/calendar.events"],
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  };
}
const g = async <T>(url: string, body?: unknown, method?: string) => api<T>(url, { token: await accessToken(await googleOAuth()), body, method });

interface MsgPart {
  mimeType: string;
  body?: { data?: string };
  parts?: MsgPart[];
  headers?: Array<{ name: string; value: string }>;
}

const b64urlDecode = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

/** The readable text of a Gmail message (plain text preferred, HTML stripped). Pure; tested. */
export function messageText(p: MsgPart): string {
  const find = (part: MsgPart, type: string): string | null => {
    if (part.mimeType === type && part.body?.data) return b64urlDecode(part.body.data);
    for (const c of part.parts ?? []) {
      const t = find(c, type);
      if (t) return t;
    }
    return null;
  };
  const plain = find(p, "text/plain");
  if (plain) return plain.trim();
  const html = find(p, "text/html");
  return html ? html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim() : "";
}

const header = (p: MsgPart, name: string) => p.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

/** RFC 2822 message for a draft, base64url-encoded. Pure; tested. */
export function rawEmail(to: string, subject: string, body: string): string {
  const enc = (s: string) => (/[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${btoa(unescape(encodeURIComponent(s)))}?=` : s);
  const msg = [`To: ${to}`, `Subject: ${enc(subject)}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "", body].join("\r\n");
  return btoa(unescape(encodeURIComponent(msg))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function googleTools(): Record<string, RegisteredTool> {
  const GM = "https://gmail.googleapis.com/gmail/v1/users/me";
  const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary";
  return {
    gmail_search: {
      spec: {
        name: "gmail_search",
        description: "Search the user's Gmail with Gmail search syntax (e.g. 'is:unread', 'from:amazon newer_than:7d'). Returns sender, subject, date and a snippet with message ids.",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
      untrustedOutput: true,
      run: async (a) => {
        const list = await g<{ messages?: Array<{ id: string }> }>(`${GM}/messages?maxResults=10&q=${encodeURIComponent(str(a.query, "query"))}`);
        if (!list.messages?.length) return "No emails match.";
        const rows = await Promise.all(
          list.messages.map((m) => g<{ id: string; snippet: string; payload: MsgPart }>(`${GM}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`))
        );
        return rows.map((m) => `[${m.id}] ${header(m.payload, "Date")} · from ${header(m.payload, "From")} · "${header(m.payload, "Subject")}": ${clip(m.snippet, 160)}`).join("\n");
      },
    },
    gmail_read: {
      spec: { name: "gmail_read", description: "Read one email in full by its id (from gmail_search).", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
      untrustedOutput: true,
      run: async (a) => {
        const m = await g<{ payload: MsgPart }>(`${GM}/messages/${encodeURIComponent(str(a.id, "id"))}?format=full`);
        return `From: ${header(m.payload, "From")}\nTo: ${header(m.payload, "To")}\nDate: ${header(m.payload, "Date")}\nSubject: ${header(m.payload, "Subject")}\n\n${clip(messageText(m.payload), 6000)}`;
      },
    },
    gmail_draft: {
      spec: {
        name: "gmail_draft",
        description: "Write an email as a draft in Gmail for the user to review and send themselves. BEV never sends email.",
        parameters: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"] },
      },
      run: async (a) => {
        const to = str(a.to, "to");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+(\s*,\s*[^\s@]+@[^\s@]+\.[^\s@]+)*$/.test(to)) throw new Error("that doesn't look like an email address");
        await g(`${GM}/drafts`, { message: { raw: rawEmail(to, str(a.subject, "subject"), str(a.body, "body")) } });
        return `Draft saved in Gmail to ${to}. The user can review and send it.`;
      },
    },
    calendar_events: {
      spec: {
        name: "calendar_events",
        description: "The user's upcoming Google Calendar events for the next N days (default 7).",
        parameters: { type: "object", properties: { days: { type: "number" }, query: { type: "string" } }, required: [] },
      },
      untrustedOutput: true,
      run: async (a) => {
        const days = Math.min(60, Math.max(1, Number(a.days) || 7));
        const q = optStr(a.query);
        const url = `${CAL}/events?singleEvents=true&orderBy=startTime&maxResults=25&timeMin=${encodeURIComponent(new Date().toISOString())}&timeMax=${encodeURIComponent(new Date(Date.now() + days * 86400_000).toISOString())}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
        const r = await g<{ items?: Array<{ summary?: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; location?: string }> }>(url);
        if (!r.items?.length) return `Nothing in the next ${days} days.`;
        return r.items
          .map((e) => {
            const s = e.start.dateTime ? new Date(e.start.dateTime).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : `${e.start.date} (all day)`;
            return `${s}: ${e.summary ?? "(no title)"}${e.location ? ` at ${e.location}` : ""}`;
          })
          .join("\n");
      },
    },
    calendar_add_event: {
      spec: {
        name: "calendar_add_event",
        description: "Add an event to the user's Google Calendar (no guests are invited). Times are local, YYYY-MM-DDTHH:MM.",
        parameters: {
          type: "object",
          properties: { title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, location: { type: "string" }, description: { type: "string" } },
          required: ["title", "start"],
        },
      },
      run: async (a) => {
        const start = new Date(str(a.start, "start"));
        if (Number.isNaN(start.getTime())) throw new Error("start must be a date and time like 2026-11-20T15:00");
        const end = optStr(a.end) ? new Date(str(a.end, "end")) : new Date(start.getTime() + 3600_000);
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const ev = await g<{ htmlLink: string }>(`${CAL}/events`, {
          summary: str(a.title, "title"),
          location: optStr(a.location),
          description: optStr(a.description),
          start: { dateTime: start.toISOString(), timeZone: tz },
          end: { dateTime: end.toISOString(), timeZone: tz },
        });
        return `Added "${a.title}" on ${start.toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}. ${ev.htmlLink}`;
      },
    },
  };
}
