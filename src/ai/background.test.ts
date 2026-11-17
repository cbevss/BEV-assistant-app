import { describe, it, expect, vi, beforeEach } from "vitest";
import { configureBackground, startBackgroundTask, cancelBackgroundTask, useBackground, describeTask, MAX_RUNNING } from "./background";

type Hooks = Parameters<Parameters<typeof configureBackground>[0]["makeOrchestrator"]>[1];

function setup(run: (h: Hooks, goal: string, signal?: AbortSignal) => Promise<string>) {
  const notify = vi.fn();
  configureBackground({
    makeProvider: () => ({}) as never,
    makeOrchestrator: (_p, h) => ({ send: (g, s) => run(h, g, s) }),
    notify,
  });
  return notify;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => useBackground.setState({ tasks: [] }));

describe("background tasks", () => {
  it("tracks plan, steps and result, then notifies", async () => {
    const notify = setup(async (h, goal) => {
      h.onPlan([{ text: "Search", status: "done" }, { text: "Summarise", status: "in_progress" }]);
      h.onToolResult("web_search", true, "3 results");
      expect(await h.requestApproval({ id: "1", name: "power_action", args: {} }, "BEV wants to restart the PC.")).toBe(false);
      return `Finished: ${goal}`;
    });
    const t = startBackgroundTask("compare monitors");
    await flush();
    const done = useBackground.getState().tasks.find((x) => x.id === t.id)!;
    expect(done.status).toBe("done");
    expect(done.result).toBe("Finished: compare monitors");
    expect(done.log[0]).toMatchObject({ tool: "web_search", ok: true });
    expect(done.needsApproval).toEqual(["BEV wants to restart the PC."]);
    expect(describeTask(done)).toMatch(/done, 1\/2 steps/);
    expect(notify).toHaveBeenCalledWith("BEV finished a task", expect.stringContaining("compare monitors"));
  });

  it("can be cancelled", async () => {
    setup(
      (_h, _g, signal) =>
        new Promise((_res, rej) => signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))
    );
    const t = startBackgroundTask("long job");
    expect(cancelBackgroundTask(t.id)).toBe(true);
    await flush();
    expect(useBackground.getState().tasks[0].status).toBe("cancelled");
    expect(cancelBackgroundTask(t.id)).toBe(false);
  });

  it("limits how many run at once", () => {
    setup(() => new Promise(() => {}));
    for (let i = 0; i < MAX_RUNNING; i++) startBackgroundTask(`job ${i}`);
    expect(() => startBackgroundTask("one too many")).toThrow(/already running/);
  });
});
