import { beforeEach, expect, it } from "vitest";
import * as db from "../src/db.ts";
import { fakeD1 } from "./helpers.ts";

const jst = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi);
const D = jst(2026, 11, 10, 23, 59);
let d1: D1Database;
beforeEach(() => {
  d1 = fakeD1();
});

it("add / get / listPending", async () => {
  const i = await db.add(d1, "1", "a", D, "math");
  await db.add(d1, "1", "b", jst(2026, 11, 9, 0, 0), null);
  await db.add(d1, "2", "c", D, null);
  expect((await db.get(d1, i))?.deadline).toBe(D);
  expect((await db.listPending(d1, "1")).map((x) => x.title)).toEqual(["b", "a"]);
  expect(await db.listPending(d1)).toHaveLength(3);
});

it("done / delete は本人のみ", async () => {
  const i = await db.add(d1, "1", "a", D, null);
  expect(await db.markDone(d1, "2", i)).toBe(false);
  expect(await db.remove(d1, "2", i)).toBe(false);
  expect(await db.markDone(d1, "1", i)).toBe(true);
  expect(await db.listPending(d1, "1")).toEqual([]);
  expect(await db.remove(d1, "1", i)).toBe(true);
  expect(await db.get(d1, i)).toBeNull();
  expect(await db.remove(d1, "1", i)).toBe(false);
});
