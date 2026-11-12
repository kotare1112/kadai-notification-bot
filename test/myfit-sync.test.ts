import { beforeEach, describe, expect, it } from "vitest";
import * as db from "../src/db.ts";
import { MyfitError } from "../src/myfit/errors.ts";
import { endOfDayJst, externalKey, mergeItems, toSyncItems } from "../src/myfit/sync.ts";
import { processManualSync, runSync, unlock, LOCK_KEY, RUNNING_KEY, RUNNING_TTL_MS } from "../src/sync.ts";
import { fakeD1 } from "./helpers.ts";

const jst = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi);
const NOW = jst(2026, 11, 11, 6, 0);
const raw = (title: string, deadline: string, kind = "課題", teacher = "山田 太郎") => ({ kind, title, teacher, deadline });
const ok = (items: ReturnType<typeof raw>[], complete = true) => ({ items, complete });

let d1: D1Database;
beforeEach(() => {
  d1 = fakeD1();
});

describe("pure", () => {
  it("endOfDayJst は 23:59 JST、不正日付は null", () => {
    expect(endOfDayJst("2026/11/13")).toBe(jst(2026, 11, 13, 23, 59));
    expect(endOfDayJst("2026/02/30")).toBeNull();
    expect(endOfDayJst("abc")).toBeNull();
  });
  it("externalKey は種別を課題/テストに寄せ、全角/半角と空白を正規化する(教員名は含めない)", () => {
    expect(externalKey({ kind: "課題", title: "第６回　課題" })).toBe("課題|第6回 課題");
    expect(externalKey({ kind: "コース課題", title: "a" })).toBe(externalKey({ kind: "課題", title: "a" }));
    expect(externalKey({ kind: "コーステスト", title: "a" })).toBe("テスト|a");
  });
  it("mergeItems はポータルの項目を、同じ正規化タイトルが授業一覧に無いときだけ足す", () => {
    const profile = [{ ...raw("第６回　課題", "2026/11/13 17:00"), course: "架空学入門" }];
    const portal = [raw("第6回 課題", "2026/11/13", "コース課題"), raw("別の課題", "2026/11/20", "課題")];
    expect(mergeItems(profile, portal).map((i) => i.title)).toEqual(["第６回　課題", "別の課題"]);
  });
  it("toSyncItems は重複キーと不正日付を除く", () => {
    expect(toSyncItems([raw("a", "2026/11/13"), raw("a", "2026/11/14"), raw("b", "2026/13/01")])).toHaveLength(1);
  });
});

describe("applyMyfitSync", () => {
  it("新規追加 / 締切更新 / 消えたものを提出済みにする", async () => {
    const r1 = await db.applyMyfitSync(d1, "1", toSyncItems([raw("a", "2026/11/13"), raw("b", "2026/11/20")]), NOW);
    expect(r1).toEqual({ total: 2, added: 2, updated: 0, completed: 0 });

    const r2 = await db.applyMyfitSync(d1, "1", toSyncItems([raw("a", "2026/11/15")]), NOW);
    expect(r2).toEqual({ total: 1, added: 0, updated: 1, completed: 1 });
    const pending = await db.listPending(d1, "1");
    expect(pending.map((x) => x.title)).toEqual(["a"]);
    expect(pending[0].deadline).toBe(jst(2026, 11, 15, 23, 59));
    expect(pending[0]).toMatchObject({ source: "myfit", kind: "課題", teacher: "山田 太郎" });
  });

  it("手動で完了にしたものは更新しても done のまま、同一内容は更新数に数えない", async () => {
    await db.applyMyfitSync(d1, "1", toSyncItems([raw("a", "2026/11/13")]), NOW);
    const [a] = await db.listPending(d1, "1");
    await db.markDone(d1, "1", a.id);
    const r = await db.applyMyfitSync(d1, "1", toSyncItems([raw("a", "2026/11/14")]), NOW);
    expect(r).toEqual({ total: 1, added: 0, updated: 1, completed: 0 });
    expect(await db.listPending(d1, "1")).toEqual([]);
    expect(await db.applyMyfitSync(d1, "1", toSyncItems([raw("a", "2026/11/14")]), NOW)).toEqual({
      total: 1,
      added: 0,
      updated: 0,
      completed: 0,
    });
  });

  it("手動登録の課題やほかのユーザーの課題には触れない", async () => {
    await db.add(d1, "1", "manual", jst(2026, 12, 1), null);
    await db.applyMyfitSync(d1, "2", toSyncItems([raw("a", "2026/11/13")]), NOW);
    const r = await db.applyMyfitSync(d1, "1", [], NOW);
    expect(r).toEqual({ total: 0, added: 0, updated: 0, completed: 0 });
    expect(await db.listPending(d1)).toHaveLength(2);
  });

  it("0 件でも成功(myfit 由来は全部提出済みになる)", async () => {
    await db.applyMyfitSync(d1, "1", toSyncItems([raw("a", "2026/11/13")]), NOW);
    expect(await db.applyMyfitSync(d1, "1", [], NOW)).toEqual({ total: 0, added: 0, updated: 0, completed: 1 });
  });
});

describe("授業一覧由来の講義名・時刻", () => {
  const withDetail = (deadline: string, course: string | null) => ({ ...raw("a", deadline), course });

  it("時刻と講義名を保存し、変わったら更新に数える", async () => {
    await db.applyMyfitSync(d1, "1", toSyncItems([withDetail("2026/11/13 17:30", "架空学入門")]), NOW);
    const [a] = await db.listPending(d1, "1");
    expect(a.deadline).toBe(jst(2026, 11, 13, 17, 30));
    expect(a.course).toBe("架空学入門");
    const r = await db.applyMyfitSync(d1, "1", toSyncItems([withDetail("2026/11/13 18:00", "架空学入門")]), NOW);
    expect(r.updated).toBe(1);
    const r2 = await db.applyMyfitSync(d1, "1", toSyncItems([withDetail("2026/11/13 18:00", "架空学演習")]), NOW);
    expect(r2.updated).toBe(1);
    expect((await db.listPending(d1, "1"))[0].course).toBe("架空学演習");
  });

  it("日付だけの回(ポータル由来)は、同じ日付なら前回の時刻と講義名を保つ", async () => {
    await db.applyMyfitSync(d1, "1", toSyncItems([withDetail("2026/11/13 17:30", "架空学入門")]), NOW);
    const r = await db.applyMyfitSync(d1, "1", toSyncItems([raw("a", "2026/11/13")]), NOW);
    expect(r.updated).toBe(0);
    const [a] = await db.listPending(d1, "1");
    expect(a.deadline).toBe(jst(2026, 11, 13, 17, 30));
    expect(a.course).toBe("架空学入門");
  });

  it("種別は課題/テストで保存し、教員名は teacher 列に入る", async () => {
    await db.applyMyfitSync(d1, "1", toSyncItems([raw("t", "2026/11/13 09:00", "コーステスト", "佐藤 花子")]), NOW);
    expect((await db.listPending(d1, "1"))[0]).toMatchObject({ kind: "テスト", teacher: "佐藤 花子", external_key: "テスト|t" });
  });

  it("時刻なしは 23:59", () => {
    expect(toSyncItems([raw("a", "2026/11/13")])[0].deadline).toBe(jst(2026, 11, 13, 23, 59));
  });
});

describe("旧キー(kind|title|teacher)の行の移行", () => {
  const seedOld = async (kind: string, title: string, teacher: string, done = 0) => {
    await d1
      .prepare(
        "INSERT INTO assignments (user_id, title, course, deadline, created_at, source, external_key, kind, teacher, done) VALUES ('1', ?, NULL, ?, ?, 'myfit', ?, ?, ?, ?)",
      )
      .bind(title, "2026-11-13T23:59:00+09:00", "2026-11-01T00:00:00+09:00", `${kind}|${title}|${teacher}`, kind, teacher, done)
      .run();
  };

  it("重複させず新キーに書き換え、done は保つ", async () => {
    await seedOld("コース課題", "第６回　課題", "山田 太郎");
    await seedOld("コーステスト", "確認テスト", "佐藤 花子", 1);
    const items = toSyncItems([
      { ...raw("第6回 課題", "2026/11/13 17:00"), course: "架空学入門" },
      { ...raw("確認テスト", "2026/11/13 23:59", "テスト"), course: "架空学演習" },
    ]);
    const r = await db.applyMyfitSync(d1, "1", items, NOW);
    expect(r).toEqual({ total: 2, added: 0, updated: 2, completed: 0 });
    const { results } = await d1.prepare("SELECT title, kind, external_key, course, done FROM assignments ORDER BY id").all();
    expect(results).toEqual([
      { title: "第６回　課題", kind: "課題", external_key: "課題|第6回 課題", course: "架空学入門", done: 0 },
      { title: "確認テスト", kind: "テスト", external_key: "テスト|確認テスト", course: "架空学演習", done: 1 },
    ]);
    // 2 回目は変更なし
    expect(await db.applyMyfitSync(d1, "1", items, NOW)).toEqual({ total: 2, added: 0, updated: 0, completed: 0 });
  });

  it("旧キーの行が一覧に無ければ(complete のとき)提出済みになる", async () => {
    await seedOld("課題", "消えた課題", "山田 太郎");
    expect(await db.applyMyfitSync(d1, "1", [], NOW)).toEqual({ total: 0, added: 0, updated: 0, completed: 1 });
  });
});

describe("complete=false(一部の授業を読めなかった回)", () => {
  it("一覧に無い項目を提出済みにしない", async () => {
    await db.applyMyfitSync(d1, "1", toSyncItems([raw("a", "2026/11/13"), raw("b", "2026/11/20")]), NOW);
    const r = await db.applyMyfitSync(d1, "1", toSyncItems([raw("a", "2026/11/13")]), NOW, false);
    expect(r).toEqual({ total: 1, added: 0, updated: 0, completed: 0 });
    expect(await db.listPending(d1, "1")).toHaveLength(2);
    // 新規追加・更新は行う
    const r2 = await db.applyMyfitSync(d1, "1", toSyncItems([raw("c", "2026/11/21")]), NOW, false);
    expect(r2).toEqual({ total: 1, added: 1, updated: 0, completed: 0 });
  });
});

describe("runSync", () => {
  const env = () => ({ DB: d1, DISCORD_OWNER_ID: "1", MYFIT_ID: "id", MYFIT_PASSWORD: "pw" });
  const fail = (code: ConstructorParameters<typeof MyfitError>[0]) => async () => {
    throw new MyfitError(code, "x");
  };

  it("成功", async () => {
    const r = await runSync(env(), async () => ok([raw("a", "2026/11/13")]), NOW);
    expect(r).toEqual({ ok: true, counts: { total: 1, added: 1, updated: 0, completed: 0 }, complete: true });
  });

  it("complete=false の回は提出済みにせず、結果にも反映する", async () => {
    await runSync(env(), async () => ok([raw("a", "2026/11/13")]), NOW);
    const r = await runSync(env(), async () => ok([], false), NOW);
    expect(r).toEqual({ ok: true, counts: { total: 0, added: 0, updated: 0, completed: 0 }, complete: false });
    expect(await db.listPending(d1, "1")).toHaveLength(1);
  });

  it("owner が REPLACE_ME / 未設定なら実行しない", async () => {
    let called = false;
    const scrape = async () => ((called = true), ok([]));
    expect((await runSync({ ...env(), DISCORD_OWNER_ID: "REPLACE_ME" }, scrape, NOW)).ok).toBe(false);
    expect((await runSync({ ...env(), DISCORD_OWNER_ID: undefined }, scrape, NOW)).ok).toBe(false);
    expect((await runSync({ ...env(), MYFIT_PASSWORD: undefined }, scrape, NOW)).ok).toBe(false);
    expect(called).toBe(false);
  });

  it("bad_password でロックし、以後はログインを試みない。unlock で再開", async () => {
    expect(await runSync(env(), fail("bad_password"), NOW)).toEqual({ ok: false, code: "bad_password" });
    expect(await db.getState(d1, LOCK_KEY)).toBe("1");
    let called = false;
    const scrape = async () => ((called = true), ok([]));
    expect(await runSync(env(), scrape, NOW)).toEqual({ ok: false, code: "locked" });
    expect(called).toBe(false);
    await unlock(d1);
    expect((await runSync(env(), scrape, NOW)).ok).toBe(true);
    expect(called).toBe(true);
  });

  it.each(["mfa_required", "blocked"] as const)("%s でもロックする(不審なサインインを毎日繰り返さない)", async (code) => {
    expect(await runSync(env(), fail(code), NOW)).toEqual({ ok: false, code });
    expect(await db.getState(d1, LOCK_KEY)).toBe("1");
  });

  it("timeout ではロックせず、失敗時は DB を変更しない", async () => {
    await runSync(env(), async () => ok([raw("a", "2026/11/13")]), NOW);
    expect(await runSync(env(), fail("timeout"), NOW)).toEqual({ ok: false, code: "timeout" });
    expect(await db.getState(d1, LOCK_KEY)).toBeNull();
    expect(await db.listPending(d1, "1")).toHaveLength(1);
  });

  it("想定外の例外は unknown", async () => {
    expect(await runSync(env(), async () => { throw new Error("boom"); }, NOW)).toEqual({ ok: false, code: "unknown" });
  });
});

describe("runSync の多重実行防止", () => {
  const env = () => ({ DB: d1, DISCORD_OWNER_ID: "1", MYFIT_ID: "id", MYFIT_PASSWORD: "pw" });

  it("実行中は busy を返し、scrape を呼ばない", async () => {
    await db.setState(d1, RUNNING_KEY, String(NOW));
    let called = false;
    const scrape = async () => ((called = true), ok([]));
    expect(await runSync(env(), scrape, NOW + 60_000)).toEqual({ ok: false, code: "busy" });
    expect(called).toBe(false);
    expect(await db.getState(d1, RUNNING_KEY)).toBe(String(NOW));
  });

  it("5 分以上経っていれば再実行できる", async () => {
    await db.setState(d1, RUNNING_KEY, String(NOW));
    expect((await runSync(env(), async () => ok([]), NOW + RUNNING_TTL_MS + 1)).ok).toBe(true);
  });

  it("scrape 中はフラグが立ち、成功・失敗のどちらでも消える", async () => {
    let during: string | null = null;
    await runSync(env(), async () => ((during = await db.getState(d1, RUNNING_KEY)), ok([])), NOW);
    expect(during).toBe(String(NOW));
    expect(await db.getState(d1, RUNNING_KEY)).toBeNull();
    await runSync(env(), async () => { throw new MyfitError("timeout", "x"); }, NOW);
    expect(await db.getState(d1, RUNNING_KEY)).toBeNull();
    await runSync(env(), async () => { throw new Error("boom"); }, NOW);
    expect(await db.getState(d1, RUNNING_KEY)).toBeNull();
  });
});

describe("processManualSync", () => {
  const mk = () => {
    const acks: number[] = [];
    return { acks, msg: { body: { type: "manual_sync" as const, interactionToken: "tok" }, ack: () => void acks.push(1) } };
  };

  it("結果で元の応答を差し替え、ack する", async () => {
    const { msg, acks } = mk();
    const edits: [string, string][] = [];
    await processManualSync(msg, async () => ({ ok: true, complete: true, counts: { total: 5, added: 1, updated: 2, completed: 3 } }), async (t, c) => void edits.push([t, c]));
    expect(edits).toEqual([["tok", "✅ myFIT の未提出: 5件(新規 1件 / 更新 2件 / 提出済み 3件)"]]);
    expect(acks).toHaveLength(1);
  });

  it("complete=false なら提出済みの判定を行わなかった旨を添える", async () => {
    const { msg } = mk();
    const edits: string[] = [];
    await processManualSync(msg, async () => ({ ok: true, complete: false, counts: { total: 1, added: 0, updated: 0, completed: 0 } }), async (_t, c) => void edits.push(c));
    expect(edits).toEqual(["✅ myFIT の未提出: 1件(新規 0件 / 更新 0件 / 提出済み 0件)\n※一部の授業を読み込めなかったため、提出済みの判定は行っていません"]);
  });

  it("失敗結果は describeFailure の文言で返す", async () => {
    const { msg } = mk();
    const edits: string[] = [];
    await processManualSync(msg, async () => ({ ok: false, code: "busy" }), async (_t, c) => void edits.push(c));
    expect(edits).toEqual(["❌ 別の取り込みが実行中です。少し待ってから試してください。"]);
  });

  it("run が例外でも、edit が失敗しても ack する", async () => {
    const a = mk();
    await processManualSync(a.msg, async () => { throw new Error("boom"); }, async () => {});
    expect(a.acks).toHaveLength(1);
    const b = mk();
    await processManualSync(b.msg, async () => ({ ok: false, code: "timeout" }), async () => { throw new Error("edit"); });
    expect(b.acks).toHaveLength(1);
  });
});
