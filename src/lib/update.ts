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

export async function checkForUpdate(): Promise<void> {
  const { phase } = useUpdate.getState();
  if (phase === "downloading" || phase === "installing") return;
  try {
    const u = await check();
    if (!u) return;
    pending = u;
    useUpdate.setState({ phase: "available", version: u.version, progress: null, error: "" });
  } catch {
    /* offline or no release published: try again later */
  }
}

/** Check now and every half hour. */
export function startUpdateChecks() {
  void checkForUpdate();
  setInterval(() => void checkForUpdate(), CHECK_EVERY_MS);
}

/** Download, install and restart BEV. */
export async function installUpdate(): Promise<void> {
  if (!pending) return;
  const u = pending;
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
