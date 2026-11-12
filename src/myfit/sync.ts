// myFIT の取り込み結果と DB の差分を計算する純粋関数。
import type { RawItem } from "./extract.ts";

export interface SyncItem {
  key: string;
  /** 「課題」または「テスト」 */
  kind: string;
  title: string;
  teacher: string;
  /** epoch ミリ秒(JST)。時刻が取れなかったときは締切日の 23:59 */
  deadline: number;
  /** 一覧から時刻まで取れた締切か(false なら日付だけが確かな 23:59 扱い) */
  timeKnown: boolean;
  course: string | null;
}

export interface ExistingRow {
  id: number;
  external_key?: string | null;
  deadline: number;
  done: number;
  source?: string;
  course?: string | null;
  kind?: string | null;
  title?: string;
  teacher?: string | null;
}

export interface SyncPlan {
  insert: SyncItem[];
  /** 締切・講義名のほか、旧形式のキー(kind|title|teacher)を新形式に直すための key / kind も更新する */
  update: { id: number; deadline: number; course: string | null; key: string; kind: string; teacher: string | null }[];
  /** 一覧から消えた(=提出済みとみなす)行の ID */
  complete: number[];
}

export interface SyncCounts {
  /** 今回の取り込み対象の総数 */
  total: number;
  added: number;
  updated: number;
  completed: number;
}

const JST_OFFSET = 9 * 3_600_000;
const DAY = 86_400_000;

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim();

/** 「テスト」を含めばテスト、そうでなければ課題(コース課題 / コーステスト などを寄せる) */
export function normKind(kind: string): "課題" | "テスト" {
  return kind.includes("テスト") ? "テスト" : "課題";
}

export function externalKey(i: Pick<RawItem, "kind" | "title">): string {
  return `${normKind(i.kind)}|${norm(i.title)}`;
}

/**
 * 授業ごとの一覧(profile)を主とし、ポータルの「期限あり」(portal)は同じ正規化タイトルが profile に無いものだけ足す。
 * portal は日付のみ・講義名不明のまま渡す(のちに 23:59 扱いになる)。
 */
export function mergeItems(profile: RawItem[], portal: RawItem[]): RawItem[] {
  const titles = new Set(profile.map((i) => norm(i.title)));
  return [...profile, ...portal.filter((i) => !titles.has(norm(i.title)))];
}

/** 'YYYY/MM/DD' か 'YYYY/MM/DD HH:MM'を JST として(時刻省略時は 23:59) epoch ミリ秒にする。不正な日付は null。 */
export function endOfDayJst(text: string): number | null {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let [h, mi] = [23, 59];
  if (m[4] !== undefined && Number(m[4]) <= 23 && Number(m[5]) <= 59) [h, mi] = [Number(m[4]), Number(m[5])];
  const utc = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) return null;
  return utc.getTime() - JST_OFFSET;
}

/** RawItem を SyncItem にする。日付が不正な行は捨て、同じキーは最初の 1 件だけ残す。 */
export function toSyncItems(raw: RawItem[]): SyncItem[] {
  const seen = new Map<string, SyncItem>();
  for (const r of raw) {
    const deadline = endOfDayJst(r.deadline);
    if (deadline === null) continue;
    const key = externalKey(r);
    if (!seen.has(key)) {
      const timeKnown = /\s\d{1,2}:\d{2}$/.test(r.deadline.trim());
      seen.set(key, { key, kind: normKind(r.kind), title: r.title, teacher: r.teacher, deadline, timeKnown, course: r.course?.trim() || null });
    }
  }
  return [...seen.values()];
}

/**
 * existing は同一ユーザーの全行(external_key が NULL の手動分は無視される)。
 * myFIT 由来の行は、旧キー(kind|title|teacher)で保存されていても kind と title から新キーを作って照合し、キーを書き換える。
 * complete が false(一部の授業を読めなかった回)のときは、一覧に無いものを提出済みにしない。
 */
export function planSync(existing: ExistingRow[], items: SyncItem[], complete = true): SyncPlan {
  type Entry = { row: ExistingRow; key: string };
  const entries: Entry[] = [];
  for (const e of existing) {
    if (!e.external_key) continue;
    const key = e.source === "myfit" && e.title !== undefined ? externalKey({ kind: e.kind ?? "", title: e.title }) : e.external_key;
    entries.push({ row: e, key });
  }
  // すでに新キーの行を優先して残す(旧キーの行が同じ新キーに重なった場合、後続は重複として扱う)
  entries.sort((a, b) => Number(b.row.external_key === b.key) - Number(a.row.external_key === a.key) || a.row.id - b.row.id);
  const byKey = new Map<string, ExistingRow>();
  const dups: ExistingRow[] = [];
  for (const { row, key } of entries) {
    if (byKey.has(key)) dups.push(row);
    else byKey.set(key, row);
  }
  const scraped = new Set(items.map((i) => i.key));

  const plan: SyncPlan = { insert: [], update: [], complete: [] };
  for (const i of items) {
    const e = byKey.get(i.key);
    if (!e) plan.insert.push(i);
    else {
      // 時刻まで読めなかった回(日付だけ)は、同じ日付なら前回取れた時刻を保つ
      const sameDay = Math.floor((e.deadline + JST_OFFSET) / DAY) === Math.floor((i.deadline + JST_OFFSET) / DAY);
      const deadline = !i.timeKnown && sameDay ? e.deadline : i.deadline;
      const course = i.course ?? e.course ?? null; // 講義名が取れなかった回は既存値を消さない
      const teacher = i.teacher || e.teacher || null;
      if (
        deadline !== e.deadline ||
        course !== (e.course ?? null) ||
        e.external_key !== i.key ||
        e.kind !== i.kind ||
        teacher !== (e.teacher ?? null)
      ) {
        plan.update.push({ id: e.id, deadline, course, key: i.key, kind: i.kind, teacher });
      }
    }
  }
  if (complete) {
    for (const [key, e] of byKey) {
      if (e.source === "myfit" && !e.done && !scraped.has(key)) plan.complete.push(e.id);
    }
    // 新キーが重なった重複行は残しても通知が二重になるだけなので、未完了なら提出済みにする
    for (const e of dups) if (e.source === "myfit" && !e.done) plan.complete.push(e.id);
  }
  return plan;
}
