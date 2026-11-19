import { describe, it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
import { formatHits, needsReindex, describeReport, REINDEX_AFTER_MS } from "./documents";

describe("documents", () => {
  it("groups passages by document with pages", () => {
    const t = formatHits(
      [
        { path: "C:\\D\\Lease.pdf", name: "Lease.pdf", page: 3, snippet: "the [tenancy]   ends on\n31 May" },
        { path: "C:\\D\\Lease.pdf", name: "Lease.pdf", page: 7, snippet: "two months' [notice]" },
      ],
      [{ path: "C:\\D\\Lease 2024.pdf", name: "Lease 2024.pdf", page: 0, snippet: "" }],
    );
    expect(t).toBe("Lease.pdf (C:\\D\\Lease.pdf)\n  p.3: the [tenancy] ends on 31 May\n  p.7: two months' [notice]\nDocuments whose names match: Lease 2024.pdf (C:\\D\\Lease 2024.pdf)");
    expect(formatHits([], [])).toBe("");
  });

  it("re-reads only with folders and when stale", () => {
    expect(needsReindex([], undefined)).toBe(false);
    expect(needsReindex(["C:\\D"], undefined)).toBe(true);
    expect(needsReindex(["C:\\D"], 1000, 1000 + REINDEX_AFTER_MS - 1)).toBe(false);
    expect(needsReindex(["C:\\D"], 1000, 1000 + REINDEX_AFTER_MS + 1)).toBe(true);
  });

  it("describes a run", () => {
    expect(describeReport({ indexed: 3, unchanged: 10, removed: 0, unreadable: 1 })).toBe("read 3 new or changed, 10 unchanged, 1 couldn't be read");
  });
});
