import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { tidyPlan, describePlan, kindOf, formatSize, reversal, recordChange, undoLast, _resetHistory, baseName, dirName, joinPath, type FileEntry } from "./files";

const f = (name: string, modified = Date.UTC(2026, 10, 3), dir = false): FileEntry => ({ name, path: `C:\\Users\\me\\Downloads\\${name}`, dir, size: 1000, modified });

describe("paths", () => {
  it("splits and joins Windows paths", () => {
    expect(baseName("C:\\Users\\me\\Downloads\\a.pdf")).toBe("a.pdf");
    expect(dirName("C:\\Users\\me\\Downloads\\a.pdf")).toBe("C:\\Users\\me\\Downloads");
    expect(joinPath("C:\\Users\\me\\", "Images")).toBe("C:\\Users\\me\\Images");
  });
});

describe("tidyPlan", () => {
  const entries = [f("photo.JPG"), f("cv.pdf"), f("setup.exe"), f("song.mp3"), f("thing.xyz"), f("Images", 0, true), f("big.iso.crdownload")];

  it("groups loose files by type and leaves folders and half-downloads", () => {
    const plan = tidyPlan("C:\\Users\\me\\Downloads", entries, "type");
    expect(plan.moves).toHaveLength(5);
    expect(plan.groups).toEqual({ Images: 1, Documents: 1, Installers: 1, Music: 1, Other: 1 });
    expect(plan.moves[0]).toEqual({ from: "C:\\Users\\me\\Downloads\\photo.JPG", to: "C:\\Users\\me\\Downloads\\Images" });
    expect(describePlan("C:\\Users\\me\\Downloads", plan)).toMatch(/^Sort 5 files in Downloads into 5 folders/);
  });

  it("groups by month", () => {
    const plan = tidyPlan("C:\\D", [f("a.pdf", Date.UTC(2026, 10, 3)), f("b.pdf", Date.UTC(2026, 9, 3))], "month");
    expect(Object.keys(plan.groups).sort()).toEqual(["November 2026", "October 2026"]);
  });

  it("knows common kinds", () => {
    expect(kindOf("Budget.XLSX")).toBe("Spreadsheets");
    expect(kindOf("model.stl")).toBe("3D and design");
  });
});

describe("formatSize", () => {
  it("reads like Explorer", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(250 * 1024 * 1024)).toBe("250 MB");
  });
});

describe("undo", () => {
  beforeEach(() => {
    _resetHistory();
    vi.mocked(invoke).mockReset();
  });

  it("moves things back in reverse order, and bins copies", () => {
    const items = [{ from: "C:\\a\\x.txt", to: "C:\\b\\x.txt" }, { from: "C:\\a\\y.txt", to: "C:\\b\\y (2).txt" }];
    expect(reversal({ kind: "move", items, at: 0, summary: "" }).moveBack).toEqual([
      { from: "C:\\b\\y (2).txt", to: "C:\\a\\y.txt" },
      { from: "C:\\b\\x.txt", to: "C:\\a\\x.txt" },
    ]);
    expect(reversal({ kind: "copy", items, at: 0, summary: "" })).toEqual({ moveBack: [], bin: ["C:\\b\\x.txt", "C:\\b\\y (2).txt"] });
  });

  it("undoes the latest change once", async () => {
    vi.mocked(invoke).mockResolvedValue({ done: [{ from: "C:\\b\\x.txt", to: "C:\\a\\x.txt" }], failed: [] });
    recordChange({ kind: "move", items: [{ from: "C:\\a\\x.txt", to: "C:\\b\\x.txt" }], at: 0, summary: "tidy a" });
    expect(await undoLast()).toMatch(/Undid "tidy a"\. Put back 1 item/);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("files_move", { items: [{ from: "C:\\b\\x.txt", to: "C:\\a\\x.txt" }], copy: false });
    expect(await undoLast()).toMatch(/nothing to undo/);
  });
});
