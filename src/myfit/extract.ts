// 期限あり一覧(.dispTab_2)の DOM から課題・テストを取り出す純粋関数。
// page.evaluate に関数ごと渡すため、外部の変数・関数を参照せず、内部にも名前付き関数を作らない。

export interface RawItem {
  /** 「課題」「テスト」、またはポータルの種別表示(コース課題 など) */
  kind: string;
  title: string;
  teacher: string;
  /** YYYY/MM/DD、または時刻まで分かるときは YYYY/MM/DD HH:MM(時刻なしは 23:59 扱い) */
  deadline: string;
  /** 講義名(分からなければ未設定) */
  course?: string | null;
}

export function extractDeadlineItems(root: ParentNode): RawItem[] {
  const out: RawItem[] = [];
  const rows = root.querySelectorAll(".dispTab_2 li.ui-dataview-row");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const kind = (row.querySelector(".signPortal")?.textContent ?? "").trim();
    if (!kind.includes("課題") && !kind.includes("テスト")) continue;

    const title = (row.querySelector("a.textTitle")?.textContent ?? "").trim();
    if (!title) continue;

    // 「期限」ラベルの後ろにある、日付を含む要素を探す
    const limit = row.querySelector(".textLimitdate");
    let deadline = "";
    for (let el = limit?.nextElementSibling ?? null; el; el = el.nextElementSibling) {
      const m = /(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(el.textContent ?? "");
      if (m) {
        deadline = `${m[1]}/${m[2].padStart(2, "0")}/${m[3].padStart(2, "0")}`;
        break;
      }
    }
    if (!deadline) continue;

    // 教員名: .textFrom のうち「[」「]」「：」以外。全角空白は半角空白 1 つに正規化する
    const froms = row.querySelectorAll(".textFrom");
    let teacher = "";
    for (let j = 0; j < froms.length; j++) {
      const t = (froms[j].textContent ?? "").replace(/[\s　]+/g, " ").trim();
      if (t && t !== "[" && t !== "]" && t !== "：" && t !== ":") {
        teacher = t;
        break;
      }
    }

    out.push({ kind, title, teacher, deadline });
  }
  return out;
}

// クラスプロファイルの「課題提出」「テスト」一覧(PrimeFaces の ui-datatable)から、受付中の未提出項目を取り出す純粋関数。
// 列は見出しの文言で探す(課題とテストで列順が違う)。page.evaluate に関数ごと渡すので、外部の変数・関数を参照せず、内部にも名前付き関数を作らない。
// fallbackCourse は「コース」セルが空のときに使う、いま開いている講義名。
export function extractCourseList(root: ParentNode, kind: "課題" | "テスト", fallbackCourse: string | null): RawItem[] {
  const out: RawItem[] = [];
  const ths = root.querySelectorAll("table thead th");
  let table: Element | null = null;
  for (let i = 0; i < ths.length && !table; i++) {
    const t = (ths[i].textContent ?? "").replace(/[\s　]+/g, "");
    if (t.includes("課題提出終了日時") || t.includes("テスト終了日時")) table = ths[i].closest("table");
  }
  if (!table) return out;

  const heads = table.querySelectorAll("thead th");
  const names: string[] = [];
  for (let i = 0; i < heads.length; i++) names.push((heads[i].textContent ?? "").replace(/[\s　]+/g, ""));
  const titleHead = kind === "テスト" ? "テスト名" : "課題名";
  const iTitle = names.indexOf(titleHead);
  let iEnd = -1;
  for (let i = 0; i < names.length; i++) {
    if (names[i].includes("課題提出終了日時") || names[i].includes("テスト終了日時")) iEnd = i;
  }
  const iCourse = names.indexOf("コース");
  const iStatus = names.indexOf("ステータス");
  const iUnsub = names.indexOf("未提出");
  if (iTitle < 0 || iEnd < 0 || iStatus < 0 || iUnsub < 0) return out;

  // 見出しと本体が別 table に分かれる場合に備え、ui-datatable 全体から本体の行を探す
  const container = table.closest(".ui-datatable") ?? table;
  const rows = container.querySelectorAll("tbody tr");
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].querySelectorAll("td");
    if (cells.length <= Math.max(iTitle, iEnd, iStatus, iUnsub)) continue;
    if ((cells[iUnsub].textContent ?? "").trim() !== "○") continue;
    if (!(cells[iStatus].textContent ?? "").includes("受付中")) continue;

    const title = (cells[iTitle].textContent ?? "").replace(/[\s　]+/g, " ").trim();
    if (!title) continue;

    const m = /(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s*[(（][^)）]*[)）])?(?:\s*(\d{1,2}):(\d{2}))?/.exec(cells[iEnd].textContent ?? "");
    if (!m) continue;
    let deadline = `${m[1]}/${m[2].padStart(2, "0")}/${m[3].padStart(2, "0")}`;
    if (m[4] !== undefined) deadline += ` ${m[4].padStart(2, "0")}:${m[5]}`;

    const courseText = iCourse >= 0 && cells.length > iCourse ? (cells[iCourse].textContent ?? "").replace(/[\s　]+/g, " ").trim() : "";
    const tm = /【([^】]*)】/.exec(courseText);
    const teacher = tm ? tm[1].replace(/[\s　]+/g, " ").trim() : "";
    const course = courseText.replace(/【[^】]*】/g, "").trim() || fallbackCourse || null;

    out.push({ kind, title, teacher, deadline, course });
  }
  return out;
}

// 講義名(.cpTgtName 直下のテキストノードだけ。科目コードの span とボタンは除く)を返す純粋関数。取れなければ null。
export function extractCurrentCourse(root: ParentNode): string | null {
  const nameEl = root.querySelector(".cpTgtName");
  if (!nameEl) return null;
  let text = "";
  for (let i = 0; i < nameEl.childNodes.length; i++) {
    const n = nameEl.childNodes[i];
    if (n.nodeType === 3) text += n.textContent ?? "";
  }
  text = text.replace(/[\s　]+/g, " ").trim();
  return text || null;
}
