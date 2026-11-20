/**
 * Daily briefing at a time the user chooses: BEV works it out in the
 * background (calendar, email, tracked tasks, what it noticed on the PC),
 * then says it if it isn't busy, notifies, and puts it in Chat.
 */
import { useSettings } from "@/state/settings";
import { isQuiet } from "@/lib/gaming";
import { startBackgroundTask, useBackground } from "@/ai/background";
import { noticesForPrompt, raise } from "./notices";

const DONE_KEY = "bev.briefing.lastDay";
const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* unavailable */
    }
  },
};

const day = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** Is it time for today's briefing? Pure; tested. */
export function briefingDue(time: string, now: Date, lastDay: string | null): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return false;
  const at = new Date(now);
  at.setHours(Number(m[1]), Number(m[2]), 0, 0);
  // Due from the set time until 3 hours later (PC was asleep at the exact minute).
  return now >= at && now.getTime() - at.getTime() < 3 * 3600_000 && lastDay !== day(now);
}

export function briefingGoal(): string {
  const noticed = noticesForPrompt();
  return [
    "Prepare the user's daily briefing, to be read aloud. Under 120 words, friendly, no lists.",
    "Include, where the tools are available: today's weather (get_weather, if their home town is set), today's calendar events (calendar_events), important unread email (gmail_search 'is:unread is:important newer_than:1d'), tracked tasks due soon (list_tracked_tasks), timers, alarms and reminders still to come today (list_timers), countdowns within a week (countdown check), and anything wrong with the PC.",
    "Skip any source that isn't connected without mentioning it. Don't invent anything.",
    noticed,
  ]
    .filter(Boolean)
    .join("\n");
}

export interface BriefingDeps {
  announce: (text: string) => Promise<boolean>;
  toChat: (text: string) => void;
}

let started = false;
export function startBriefings(deps: BriefingDeps) {
  if (started) return;
  started = true;
  setInterval(() => {
    const s = useSettings.getState().settings;
    if (!s.briefingTime || !briefingDue(s.briefingTime, new Date(), ls.get(DONE_KEY))) return;
    ls.set(DONE_KEY, day(new Date()));
    let task;
    try {
      task = startBackgroundTask(briefingGoal(), { title: "Daily briefing", quiet: true });
    } catch {
      return; // two tasks already running: skip today rather than nag
    }
    const unsub = useBackground.subscribe((st) => {
      const t = st.tasks.find((x) => x.id === task!.id);
      if (!t || t.status === "running") return;
      unsub();
      if (t.status !== "done" || !t.result) return;
      deps.toChat(t.result);
      raise("briefing", "Your briefing", t.result.slice(0, 220), { key: `briefing:${day(new Date())}` });
      if (useSettings.getState().settings.briefingSpoken && !isQuiet()) deps.announce(t.result).catch(() => {});
    });
  }, 60_000);
}
