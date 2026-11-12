import { afterEach, describe, expect, it, vi } from "vitest";
import { notifier } from "../src/discord.ts";

function mockFetch() {
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ id: "dm-channel" }), { status: 200 });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("notifier", () => {
  it("チャンネル ID があればそのチャンネルにメンション付きで投稿する", async () => {
    const calls = mockFetch();
    await notifier("t", "123")("u1", "本文");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/channels\/123\/messages$/);
    expect(calls[0].body.content).toBe("<@u1>\n本文");
    expect(calls[0].body.allowed_mentions).toEqual({ users: ["u1"] });
  });

  it.each([undefined, "", " ", "REPLACE_ME"])("チャンネル ID が %j なら DM で送る", async (ch) => {
    const calls = mockFetch();
    await notifier("t", ch)("u1", "本文");
    expect(calls.map((c) => c.url)).toEqual([
      expect.stringMatching(/\/users\/@me\/channels$/),
      expect.stringMatching(/\/channels\/dm-channel\/messages$/),
    ]);
    expect(calls[1].body.content).toBe("本文");
  });
});
