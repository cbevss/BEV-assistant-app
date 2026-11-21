/**
 * Start with Windows. Prefers a Task Scheduler logon task, which starts BEV as
 * soon as you sign in; the Run-key entry Windows holds back until the desktop
 * has settled is only the fallback when the task can't be created.
 */
import { invoke } from "@tauri-apps/api/core";
import { disable as runKeyOff, enable as runKeyOn, isEnabled as runKeyIsOn } from "@tauri-apps/plugin-autostart";

const fastIsOn = () => invoke<boolean>("fast_start_enabled").catch(() => false);
const setFast = (on: boolean) => invoke<void>("set_fast_start", { on });

export async function startWithWindowsEnabled(): Promise<boolean> {
  return (await fastIsOn()) || (await runKeyIsOn().catch(() => false));
}

export async function setStartWithWindows(on: boolean): Promise<void> {
  if (!on) {
    await setFast(false).catch(() => {});
    await runKeyOff().catch(() => {});
    return;
  }
  try {
    await setFast(true);
    await runKeyOff().catch(() => {}); // don't start twice
  } catch {
    await runKeyOn();
  }
}

/** Move an existing Run-key start-up to the faster task. Quiet; keeps the old one if that fails. */
export async function upgradeStartWithWindows(): Promise<void> {
  if (!(await runKeyIsOn().catch(() => false)) || (await fastIsOn())) return;
  try {
    await setFast(true);
    await runKeyOff().catch(() => {});
  } catch {
    /* keep the Run key */
  }
}
