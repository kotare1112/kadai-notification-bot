import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { extractCourseList, extractCurrentCourse, extractDeadlineItems } from "../src/myfit/extract.ts";

function load(html: string) {
  const win = new Window();
  win.document.body.innerHTML = html;
  return win.document as unknown as Document;
}
const fixture = readFileSync("test/fixtures/myfit-dispTab2.html", "utf8");

it("課題とテストだけを取り出す(掲示・アンケート・期限なしは除外)", () => {
  const items = extractDeadlineItems(load(fixture));
  expect(items.map((i) => i.kind)).toEqual(["コーステスト", "コース課題", "課題"]);
  expect(items.map((i) => i.deadline)).toEqual(["2026/11/13", "2026/11/24", "2026/12/08"]);
});

it("タイトルは前後の空白を除く", () => {
  expect(extractDeadlineItems(load(fixture))[0].title).toBe("復習課題：第６回（１月１日〆切）");
});

it("教員名の全角空白は半角空白に正規化する", () => {
  expect(extractDeadlineItems(load(fixture)).map((i) => i.teacher)).toEqual([
    "山田 太郎",
    "佐藤 花子",
    "鈴木 一郎",
  ]);
});

it(".dispTab_2 が無ければ空配列", () => {
  expect(extractDeadlineItems(load("<div>none</div>"))).toEqual([]);
});

it("Function.toString で再構成しても動く(page.evaluate 用)", () => {
  const f = new Function(`return (${extractDeadlineItems.toString()})`)() as typeof extractDeadlineItems;
  expect(f(load(fixture))).toHaveLength(3);
});

describe("extractCourseList", () => {
  const kadai = readFileSync("test/fixtures/myfit-kadai-list.html", "utf8");
  const test = readFileSync("test/fixtures/myfit-test-list.html", "utf8");

  it("課題一覧: 受付中かつ未提出の行だけ(提出済み・受付終了は除外)", () => {
    const items = extractCourseList(load(kadai), "課題", "フォールバック講義");
    expect(items.map((i) => i.title)).toEqual(["受講確認課題：第５回（１月１日〆切）", "コース欄が空の課題"]);
    expect(items[0]).toEqual({
      kind: "課題",
      title: "受講確認課題：第５回（１月１日〆切）",
      teacher: "山田 太郎",
      course: "架空学入門",
      deadline: "2026/11/13 23:59",
    });
  });

  it("コースが空なら現在の授業名を使い、1 桁の時刻は 0 埋めする", () => {
    const items = extractCourseList(load(kadai), "課題", "フォールバック講義");
    expect(items[1]).toMatchObject({ course: "フォールバック講義", teacher: "", deadline: "2026/11/20 09:05" });
    expect(extractCourseList(load(kadai), "課題", null)[1].course).toBeNull();
  });

  it("テスト一覧: 列順が違っても見出しで読み、受付終了+未提出○は除外する", () => {
    const items = extractCourseList(load(test), "テスト", "x");
    expect(items).toEqual([
      {
        kind: "テスト",
        title: "復習課題：第５回（１月１日〆切）",
        teacher: "山田 太郎",
        course: "架空学入門",
        deadline: "2026/11/13 23:59",
      },
    ]);
  });

  it("行が無い表・表が無いページは空配列", () => {
    const empty = kadai.replace(/<tbody[\s\S]*<\/tbody>/, '<tbody><tr><td colspan="11">データがありません。</td></tr></tbody>');
    expect(extractCourseList(load(empty), "課題", "x")).toEqual([]);
    expect(extractCourseList(load("<div>none</div>"), "テスト", "x")).toEqual([]);
  });

  it("Function.toString で再構成しても動く(page.evaluate 用)", () => {
    const f = new Function(`return (${extractCourseList.toString()})`)() as typeof extractCourseList;
    expect(f(load(test), "テスト", "x")).toHaveLength(1);
  });
});

describe("extractCurrentCourse", () => {
  it("講義名は科目コードとボタンを除く", () => {
    const html = readFileSync("test/fixtures/myfit-kadai-list.html", "utf8");
    expect(extractCurrentCourse(load(html))).toBe("架空学入門");
    expect(extractCurrentCourse(load("<div>x</div>"))).toBeNull();
    const f = new Function(`return (${extractCurrentCourse.toString()})`)() as typeof extractCurrentCourse;
    expect(f(load(html))).toBe("架空学入門");
  });
});
