/** Which desktop OS BEV is running on. The webview's user agent is enough:
 *  WebView2 reports "Windows", WebKitGTK reports "Linux". */
export type DesktopOS = "windows" | "linux";

export function desktopOS(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): DesktopOS {
  return /linux/i.test(ua) && !/android/i.test(ua) ? "linux" : "windows";
}

export const isLinux = (): boolean => desktopOS() === "linux";

/** How BEV describes the machine to the model. */
export function osLabel(os: DesktopOS = desktopOS()): string {
  return os === "linux" ? "Fedora Linux (KDE Plasma, Wayland) PC" : "Windows 11 PC";
}
