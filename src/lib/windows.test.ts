import { describe, expect, it } from "vitest";
import { describeWindows, matchWindow, type WinEntry } from "./windows";

const w = (hwnd: number, title: string, process: string, display = "display 1 of 2", minimized = false): WinEntry => ({ hwnd, title, process, display, minimized });

describe("finding an app's window on any monitor", () => {
  const list = [
    w(1, "BEV-assistant-app – Visual Studio Code", "Code.exe"),
    w(2, "#general | The Lads - Discord", "Discord.exe", "display 2 of 2"),
    w(3, "Spotify Premium", "Spotify.exe", "", true),
    w(4, "Discord Updater", "Update.exe"),
  ];

  it("matches by app name before window title, wherever the window is", () => {
    expect(matchWindow(list, "Discord")?.hwnd).toBe(2);
    expect(matchWindow(list, "the discord window")?.hwnd).toBe(2);
    expect(matchWindow(list, "spotify")?.hwnd).toBe(3);
    expect(matchWindow(list, "code")?.hwnd).toBe(1);
    expect(matchWindow(list, "steam")).toBeNull();
    expect(matchWindow(list, "  ")).toBeNull();
  });

  it("prefers a window on screen over a minimised one of the same app", () => {
    const two = [w(5, "Chrome", "chrome.exe", "", true), w(6, "Chrome", "chrome.exe", "display 2 of 2")];
    expect(matchWindow(two, "chrome")?.hwnd).toBe(6);
  });

  it("tells the AI where each window is", () => {
    const text = describeWindows(list);
    expect(text).toContain('hwnd 2: "#general | The Lads - Discord" (Discord.exe, display 2 of 2)');
    expect(text).toContain("(Spotify.exe, minimised)");
    expect(describeWindows([])).toBe("No app windows are open.");
  });
});
