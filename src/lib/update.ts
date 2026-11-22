/**
 * App updates: BEV checks for a newer signed release in the background and
 * shows a download button in the title bar when one is ready. Nothing installs
 * until you click it.
 */
import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type Phase = "none" | "available" | "downloading" | "installing" | "error";

interface UpdateState {
  phase: Phase;
  version: string;
  /** 0..100 while downloading, when the size is known. */
  progress: number | null;
  error: string;
}

export const useUpdate = create<UpdateState>(() => ({ phase: "none", version: "", progress: null, error: "" }));

let pending: Update | null = null;
const CHECK_EVERY_MS = 30 * 60_000;

export async function checkForUpdate(force = false): Promise<void> {
  const { phase } = useUpdate.getState();
  if (!force && (phase === "downloading" || phase === "installing")) return;
  try {
    const u = await check();
    if (!u || !isNewer(u.version, u.currentVersion)) {
      // Nothing newer (or it's been installed): no button.
      pending = null;
      useUpdate.setState({ phase: "none", version: "", progress: null, error: "" });
      return;
    }
    pending = u;
    useUpdate.setState({ phase: "available", version: u.version, progress: null, error: "" });
  } catch {
    /* offline or no release published: keep whatever we last knew, try again later */
  }
}

/** Is version `a` newer than `b`? Plain x.y.z comparison; pre-release tags ignored. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/i, "").split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** Check now and every half hour. */
export function startUpdateChecks() {
  void checkForUpdate();
  setInterval(() => void checkForUpdate(), CHECK_EVERY_MS);
}

/** Download, install and restart BEV. */
export async function installUpdate(): Promise<void> {
  // Check again right before installing, so it's always the newest release,
  // not whichever one was current when the button first appeared.
  useUpdate.setState({ phase: "downloading", progress: null, error: "" });
  await checkForUpdate(true).catch(() => {});
  if (!pending) {
    useUpdate.setState({ phase: "none", version: "", progress: null, error: "" });
    return;
  }
  const u = pending;
  useUpdate.setState({ phase: "downloading", progress: null, error: "" });
  let total = 0;
  let got = 0;
  useUpdate.setState({ phase: "downloading", progress: null, error: "" });
  try {
    await u.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data.contentLength ?? 0;
      else if (e.event === "Progress") {
        got += e.data.chunkLength;
        if (total > 0) useUpdate.setState({ progress: Math.min(100, Math.round((got / total) * 100)) });
      } else if (e.event === "Finished") useUpdate.setState({ phase: "installing", progress: 100 });
    });
    await relaunch();
  } catch (e) {
    useUpdate.setState({ phase: "error", error: String((e as { message?: string })?.message ?? e) });
  }
}
