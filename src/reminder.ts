// 通知対象の選択・メッセージ生成・締切パースなど、副作用のない純粋関数。
// JST は UTC+9 固定(DST なし)なので、+9h したずらし値を UTC として読んで JST の日時を得る。

export interface Assignment {
  id: number;
  user_id: string;
  title: string;
  course: string | null;
  /** epoch ミリ秒 */
  deadline: number;
  done: number;
  /** 'manual' | 'myfit'。省略時は manual 扱い */
  source?: string;
  external_key?: string | null;
  kind?: string | null;
  teacher?: string | null;
}

export const NOTIFY_DAYS = 3;
const WEEKDAYS = "月火水木金土日";
const HOUR = 3_600_000;
const DAY = 86_400_000;
const JST_OFFSET = 9 * HOUR;

const DT_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?$/;

function jst(ms: number) {
  const d = new Date(ms + JST_OFFSET);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
    wd: (d.getUTCDay() + 6) % 7, // 月=0
  };
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** 'YYYY-MM-DD HH:MM' / 'YYYY-MM-DD'(23:59)を JST として epoch ミリ秒にする。不正・過去は Error。 */
export function parseDeadline(text: string, now: number): number {
  const m = DT_RE.exec(text.trim());
  if (!m) {
    throw new Error("形式が正しくありません。`YYYY-MM-DD HH:MM` または `YYYY-MM-DD` で指定してください。");
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hour = m[4] !== undefined ? Number(m[4]) : 23;
  const minute = m[5] !== undefined ? Number(m[5]) : 59;
  const utc = new Date(Date.UTC(y, mo - 1, d, hour, minute));
  if (
    hour > 23 ||
    minute > 59 ||
    utc.getUTCFullYear() !== y ||
    utc.getUTCMonth() !== mo - 1 ||
    utc.getUTCDate() !== d
  ) {
    throw new Error("存在しない日付または時刻です。");
  }
  const ms = utc.getTime() - JST_OFFSET;
  if (ms < now) throw new Error("過去の日時は指定できません。");
  return ms;
}

export function daysLeft(deadline: number, now: number): number {
  return Math.floor((deadline + JST_OFFSET) / DAY) - Math.floor((now + JST_OFFSET) / DAY);
}

/** 未完了で、締切が now 以降かつ JST 日付差が 0〜3 日のものを締切昇順で返す。 */
export function selectDue(assignments: Assignment[], now: number): Assignment[] {
  return assignments
    .filter((a) => !a.done && a.deadline >= now && daysLeft(a.deadline, now) >= 0 && daysLeft(a.deadline, now) <= NOTIFY_DAYS)
    .sort((a, b) => a.deadline - b.deadline);
}

export function formatDeadline(deadline: number): string {
  const t = jst(deadline);
  return `${t.mo}/${t.d}(${WEEKDAYS[t.wd]}) ${p2(t.h)}:${p2(t.mi)}`;
}

/** JST の ISO8601 文字列(+09:00)。DB 保存用。 */
export function toIsoJst(ms: number): string {
  const t = jst(ms);
  return `${t.y}-${p2(t.mo)}-${p2(t.d)}T${p2(t.h)}:${p2(t.mi)}:${p2(t.s)}+09:00`;
}

export function formatDaysLeft(n: number): string {
  return n === 0 ? "今日まで" : `あと${n}日`;
}

/** 表示用の見出し。myFIT 由来は講義名があれば `[講義名] タイトル (テスト|課題)`、なければ `[種別] タイトル (教員)`。手動登録は `[科目] タイトル`。 */
export function formatName(a: Assignment): string {
  if (a.source === "myfit") {
    if (a.course) return `[${a.course}] ${a.title} (${a.kind?.includes("テスト") ? "テスト" : "課題"})`;
    return `${a.kind ? `[${a.kind}] ` : ""}${a.title}${a.teacher ? ` (${a.teacher})` : ""}`;
  }
  return `${a.course ? `[${a.course}] ` : ""}${a.title}`;
}

export function formatLine(a: Assignment, now: number): string {
  const n = daysLeft(a.deadline, now);
  const mark = n === 0 ? "🚨" : "⏰";
  return `${mark} 【${formatDaysLeft(n)}】${formatName(a)} — ${formatDeadline(a.deadline)}`;
}

export function buildMessage(assignments: Assignment[], now: number): string {
  return ["📚 期限が近い課題", ...assignments.map((a) => formatLine(a, now))].join("\n");
}
