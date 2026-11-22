/**
 * Keeps the installed-app index fresh without you pressing Rescan:
 * - on launch (setting "Scan for apps when BEV starts"), and
 * - after something finishes downloading (setting "Scan after downloads"),
 *   since a download is usually an installer you're about to run. BEV rescans
 *   a few times over the next several minutes to catch the install finishing.
 */
import { appsApi } from "./apps";
import { filesApi } from "./files";
import { useSettings } from "@/state/settings";

/** Files still being written by a browser or downloader. */
export const IN_PROGRESS = /\.(crdownload|part|partial|download|opdownload|!ut|tmp)$/i;
const POLL_MS = 20_000;
/** Rescans after a download: installers take a while to run. */
export const AFTER_DOWNLOAD_MS = [60_000, 3 * 60_000, 8 * 60_000];

const settings = () => useSettings.getState().settings;

let scanning = false;
async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    await appsApi.refresh();
  } catch {
    /* index will retry next time */
  } finally {
    scanning = false;
  }
}

/** Finished downloads in `now` that weren't in `before`. */
export function newDownloads(before: ReadonlySet<string>, now: readonly string[]): string[] {
  return now.filter((n) => !before.has(n.toLowerCase()) && !IN_PROGRESS.test(n));
}

let timers: ReturnType<typeof setTimeout>[] = [];
function scheduleScans() {
  timers.forEach(clearTimeout);
  timers = AFTER_DOWNLOAD_MS.map((ms) => setTimeout(() => void scan(), ms));
}

let seen: Set<string> | null = null;
async function pollDownloads() {
  if (!settings().scanAfterDownloads) {
    seen = null;
    return;
  }
  try {
    const r = await filesApi.list("%USERPROFILE%\\Downloads");
    const names = r.entries.filter((e) => !e.dir).map((e) => e.name);
    if (seen && newDownloads(seen, names).length) scheduleScans();
    // In-progress names aren't remembered, so the finished file counts as new.
    seen = new Set(names.filter((n) => !IN_PROGRESS.test(n)).map((n) => n.toLowerCase()));
  } catch {
    /* no Downloads folder or not readable */
  }
}

let started = false;
export function startAppScanning() {
  if (started) return;
  started = true;
  if (settings().scanAppsOnLaunch) setTimeout(() => void scan(), 8_000);
  void pollDownloads();
  setInterval(() => void pollDownloads(), POLL_MS);
}
