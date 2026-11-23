import { describe, it, expect } from "vitest";
import { desktopOS, osLabel } from "./os";

describe("desktopOS", () => {
  it("detects WebKitGTK on Linux", () => {
    expect(desktopOS("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15")).toBe("linux");
  });
  it("detects WebView2 on Windows", () => {
    expect(desktopOS("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/120")).toBe("windows");
  });
  it("labels each OS", () => {
    expect(osLabel("linux")).toContain("KDE");
    expect(osLabel("windows")).toContain("Windows 11");
  });
});
