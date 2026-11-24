import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { messageWithAttachments, prettySize, type Attachment } from "./attachments";

describe("attachments", () => {
  it("adds a note per attachment so BEV knows what it got", () => {
    const atts: Attachment[] = [
      { id: "1", name: "shot.png", kind: "image", path: "C:\\Users\\A\\shot.png" },
      { id: "2", name: "report.pdf", kind: "file", path: "C:\\Users\\A\\report.pdf" },
      { id: "3", name: "notes.txt", kind: "text", text: "hello" },
    ];
    const m = messageWithAttachments("what's in these?", atts);
    expect(m).toContain("what's in these?");
    expect(m).toContain("[Picture attached: shot.png (C:\\Users\\A\\shot.png)]");
    expect(m).toContain("read_document");
    expect(m).toContain("C:\\Users\\A\\report.pdf");
    expect(m).toContain("hello");
  });
  it("works with no typed message", () => {
    expect(messageWithAttachments("", [{ id: "1", name: "a.png", kind: "image" }])).toMatch(/^\(No message/);
  });
  it("leaves plain messages alone", () => {
    expect(messageWithAttachments("hi", [])).toBe("hi");
  });
  it("formats sizes", () => {
    expect(prettySize(512)).toBe("512 B");
    expect(prettySize(2048)).toBe("2 KB");
    expect(prettySize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
