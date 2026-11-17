import { it, expect, vi } from "vitest";
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
import { normaliseCloudUrl } from "./bevCloud";

it("normalises the BEV Cloud address", () => {
  expect(normaliseCloudUrl("bev-cloud.cbevss.workers.dev/")).toBe("https://bev-cloud.cbevss.workers.dev");
  expect(normaliseCloudUrl(" https://bev-cloud.x.workers.dev/api/ ")).toBe("https://bev-cloud.x.workers.dev");
  expect(normaliseCloudUrl("")).toBe("");
  expect(() => normaliseCloudUrl("http://insecure.example")).toThrow(/https/);
});
