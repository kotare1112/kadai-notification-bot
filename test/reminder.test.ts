import { describe, expect, it } from "vitest";
import { buildMessage, formatLine, formatName, parseDeadline, selectDue, type Assignment } from "../src/reminder.ts";

const jst = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi);
const NOW = jst(2026, 11, 4, 8, 0);

const a = (deadline: number, done = 0, title = "t", course: string | null = null): Assignment => ({
  id: 1,
  user_id: "1",
  title,
  course,
  deadline,
  done,
});

describe("selectDue", () => {
  it("3日後は含み4日後は除外", () => {
    const d3 = a(jst(2026, 11, 7, 23, 59));
    const d4 = a(jst(2026, 11, 8, 0, 0));
    expect(selectDue([d3, d4], NOW)).toEqual([d3]);
  });
  it("今日の過去は除外、今日の未来は含む", () => {
    const past = a(jst(2026, 11, 4, 7, 59));
    const fut = a(jst(2026, 11, 4, 23, 59));
    expect(selectDue([past, fut], NOW)).toEqual([fut]);
  });
  it("完了済みは除外", () => {
    expect(selectDue([a(NOW + 3_600_000, 1)], NOW)).toEqual([]);
  });
  it("年またぎと締切順ソート", () => {
    const now = jst(2026, 12, 30, 23, 0);
    const late = a(jst(2027, 1, 2, 10, 0), 0, "late");
    const early = a(jst(2026, 12, 31, 10, 0), 0, "early");
    expect(selectDue([late, early], now)).toEqual([early, late]);
  });
});

it("buildMessage", () => {
  const msg = buildMessage(
    [a(jst(2026, 11, 4, 23, 59), 0, "レポート", "数学"), a(jst(2026, 11, 5, 12, 0), 0, "課題2")],
    NOW,
  );
  expect(msg).toContain("📚 期限が近い課題");
  expect(msg).toContain("🚨 【今日まで】[数学] レポート — 11/4(水) 23:59");
  expect(msg).toContain("【あと1日】");
  expect(msg).toContain("11/5(木) 12:00");
});

it("myFIT 由来は [種別] タイトル (教員) で表示、手動は従来どおり", () => {
  const my = { ...a(jst(2026, 11, 4, 23, 59), 0, "小レポート１"), source: "myfit", kind: "課題", teacher: "鈴木 一郎" };
  expect(formatLine(my, NOW)).toContain("【今日まで】[課題] 小レポート１ (鈴木 一郎) — ");
  expect(formatName(a(NOW, 0, "t", "数学"))).toBe("[数学] t");
});

it("myFIT 由来で講義名があれば [講義名] タイトル (テスト|課題)", () => {
  const base = { ...a(NOW, 0, "第6回", "架空学入門"), source: "myfit", teacher: "鈴木 一郎" };
  expect(formatName({ ...base, kind: "コーステスト" })).toBe("[架空学入門] 第6回 (テスト)");
  expect(formatName({ ...base, kind: "コース課題" })).toBe("[架空学入門] 第6回 (課題)");
});

describe("parseDeadline", () => {
  it("形式", () => {
    expect(parseDeadline("2026-11-10 09:30", NOW)).toBe(jst(2026, 11, 10, 9, 30));
    expect(parseDeadline("2026/11/10", NOW)).toBe(jst(2026, 11, 10, 23, 59));
  });
  it.each(["abc", "2026-13-01", "2026-11-31", "2026-11-10 25:00", "2026-11-03", "2026-11-04 07:59"])(
    "不正: %s",
    (bad) => {
      expect(() => parseDeadline(bad, NOW)).toThrow();
    },
  );
});
