import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CRON_REMIND, CRON_SYNC } from "../src/cron.ts";

it("src/cron.ts の値が wrangler.toml の crons と一致する", () => {
  const m = /^crons\s*=\s*\[(.*)\]/m.exec(readFileSync("wrangler.toml", "utf8"));
  const crons = [...(m?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  expect(crons).toEqual([CRON_SYNC, CRON_REMIND]);
});
