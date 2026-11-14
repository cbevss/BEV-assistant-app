import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

/** Windows notification; silently does nothing if notifications are off. */
export async function notify(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    /* notifications unavailable */
  }
}
