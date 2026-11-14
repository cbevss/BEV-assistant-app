import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { native } from "./native";
import { useSettings } from "@/state/settings";

/**
 * Proactive CPU/RAM alerts (Settings → Proactive monitoring). Samples every
 * 10s, alerts only when a reading stays over its threshold for ~30s so a brief
 * spike (opening an app) doesn't nag, then stays quiet for 10 minutes.
 */
const SAMPLE_MS = 10_000;
const SUSTAINED_SAMPLES = 3;
const COOLDOWN_MS = 10 * 60_000;

let started = false;

export function startMonitor() {
  if (started) return;
  started = true;

  const over = { cpu: 0, ram: 0 };
  const lastAlert = { cpu: 0, ram: 0 };

  const alert = async (kind: "cpu" | "ram", title: string, body: string) => {
    const now = Date.now();
    if (now - lastAlert[kind] < COOLDOWN_MS) return;
    lastAlert[kind] = now;
    try {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (granted) sendNotification({ title, body });
    } catch {
      /* notifications unavailable: nothing else to do */
    }
  };

  const tick = async () => {
    const s = useSettings.getState().settings;
    if (!s.proactiveMonitoring) {
      over.cpu = over.ram = 0;
      return;
    }
    const stats = await native.getSystemStats().catch(() => null);
    if (!stats) return;

    over.cpu = stats.cpu_usage >= s.cpuAlertPercent ? over.cpu + 1 : 0;
    over.ram = stats.mem_percent >= s.ramAlertPercent ? over.ram + 1 : 0;

    if (over.cpu >= SUSTAINED_SAMPLES) {
      const top = await native.getRunningApps(1).catch(() => []);
      await alert(
        "cpu",
        "BEV: CPU running hot",
        `CPU has been at ${Math.round(stats.cpu_usage)}% for the last 30 seconds.` +
          (top[0] ? ` Biggest app right now: ${top[0].name}.` : "")
      );
    }
    if (over.ram >= SUSTAINED_SAMPLES) {
      await alert(
        "ram",
        "BEV: memory nearly full",
        `RAM is at ${Math.round(stats.mem_percent)}% (${(stats.mem_used_mb / 1024).toFixed(1)} of ${(
          stats.mem_total_mb / 1024
        ).toFixed(0)} GB).`
      );
    }
  };

  setInterval(() => tick().catch(() => {}), SAMPLE_MS);
}
