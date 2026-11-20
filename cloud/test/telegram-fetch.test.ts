import { describe, it, expect } from "vitest";
import { Telegram } from "../src/telegram";

describe("Telegram fetch", () => {
  it("calls fetch unbound, as Cloudflare Workers require", async () => {
    // Like Workers' fetch: throws if `this` is anything but undefined/globalThis.
    const strictFetch = function (this: unknown, url: string) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { url } })));
    } as unknown as typeof fetch;
    const tg = new Telegram(" 123:abc \n", strictFetch);
    await expect(tg.setWebhook("https://x.example/tg", "secret")).resolves.toEqual({ url: "https://api.telegram.org/bot123:abc/setWebhook" });
  });
});
