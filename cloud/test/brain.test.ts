import { it, expect } from "vitest";
import { Store } from "../src/db";
import { Brain } from "../src/brain";
import { parseWhen } from "../src/schedule";
import { scriptedChat, testEnv } from "./fakes";

it("turns a request into a task and remembers the exchange", async () => {
  const env = testEnv();
  const store = new Store(env.DB);
  const now = parseWhen("2026-11-16T12:00", env.TIMEZONE)!;
  const ai = scriptedChat([
    (req) => {
      expect(req.system).toMatch(/Current time: Mon 16 Nov, 12:00/);
      expect(req.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["add_task", "read_webpage", "call_me"]));
      return { toolCalls: [{ id: "a", name: "add_task", args: { kind: "reminder", title: "Ring the garage", when: "2026-11-16T18:00" } }] };
    },
    (req) => {
      const last = req.messages.at(-1)!;
      expect(last.role === "tool" && last.content).toMatch(/Added: #1/);
      return { text: "Done, I'll remind you at 6." };
    },
  ]);
  const brain = new Brain(env, store, { chat: ai.chat, now: () => now });
  expect(await brain.reply("remind me at 6 to ring the garage")).toBe("Done, I'll remind you at 6.");
  expect((await store.listTasks()).map((t) => t.title)).toEqual(["Ring the garage"]);
  expect(await store.recentMessages()).toEqual([
    { role: "user", content: "remind me at 6 to ring the garage" },
    { role: "assistant", content: "Done, I'll remind you at 6." },
  ]);
});
