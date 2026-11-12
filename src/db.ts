// D1 による課題の保存。user_id は snowflake の精度を保つため文字列で扱う。
import { planSync, type SyncCounts, type SyncItem } from "./myfit/sync.ts";
import { toIsoJst, type Assignment } from "./reminder.ts";

interface Row {
  id: number;
  user_id: string;
  title: string;
  course: string | null;
  deadline: string;
  done: number;
  source: string;
  external_key: string | null;
  kind: string | null;
  teacher: string | null;
}

function toAssignment(r: Row): Assignment {
  return { ...r, deadline: new Date(r.deadline).getTime() };
}

export async function add(
  db: D1Database,
  userId: string,
  title: string,
  deadline: number,
  course: string | null,
  now: number = Date.now(),
): Promise<number> {
  const res = await db
    .prepare("INSERT INTO assignments (user_id, title, course, deadline, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(userId, title, course, toIsoJst(deadline), toIsoJst(now))
    .run();
  return Number(res.meta.last_row_id);
}

export async function get(db: D1Database, id: number): Promise<Assignment | null> {
  const r = await db.prepare("SELECT * FROM assignments WHERE id = ?").bind(id).first<Row>();
  return r ? toAssignment(r) : null;
}

/** 未完了の課題を締切順に返す。userId 省略時は全ユーザー分。 */
export async function listPending(db: D1Database, userId?: string): Promise<Assignment[]> {
  const stmt =
    userId === undefined
      ? db.prepare("SELECT * FROM assignments WHERE done = 0")
      : db.prepare("SELECT * FROM assignments WHERE done = 0 AND user_id = ?").bind(userId);
  const { results } = await stmt.all<Row>();
  return results.map(toAssignment).sort((a, b) => a.deadline - b.deadline || a.id - b.id);
}

export async function markDone(db: D1Database, userId: string, id: number): Promise<boolean> {
  const res = await db.prepare("UPDATE assignments SET done = 1 WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return res.meta.changes > 0;
}

export async function remove(db: D1Database, userId: string, id: number): Promise<boolean> {
  const res = await db.prepare("DELETE FROM assignments WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return res.meta.changes > 0;
}

/** myFIT の取り込み結果を反映する。取り込みに成功したときだけ呼ぶこと。complete が false のときは、一覧に無い課題を提出済みにしない。 */
export async function applyMyfitSync(
  db: D1Database,
  userId: string,
  items: SyncItem[],
  now: number = Date.now(),
  complete = true,
): Promise<SyncCounts> {
  const { results } = await db
    .prepare("SELECT * FROM assignments WHERE user_id = ? AND external_key IS NOT NULL")
    .bind(userId)
    .all<Row>();
  const plan = planSync(results.map(toAssignment), items, complete);

  for (const i of plan.insert) {
    await db
      .prepare(
        "INSERT INTO assignments (user_id, title, course, deadline, created_at, source, external_key, kind, teacher) VALUES (?, ?, ?, ?, ?, 'myfit', ?, ?, ?)",
      )
      .bind(userId, i.title, i.course, toIsoJst(i.deadline), toIsoJst(now), i.key, i.kind, i.teacher)
      .run();
  }
  for (const u of plan.update) {
    await db
      .prepare("UPDATE assignments SET deadline = ?, course = ?, external_key = ?, kind = ?, teacher = ? WHERE id = ?")
      .bind(toIsoJst(u.deadline), u.course, u.key, u.kind, u.teacher, u.id)
      .run();
  }
  for (const id of plan.complete) {
    await db.prepare("UPDATE assignments SET done = 1 WHERE id = ?").bind(id).run();
  }
  return { total: items.length, added: plan.insert.length, updated: plan.update.length, completed: plan.complete.length };
}

export async function getState(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare("SELECT value FROM sync_state WHERE key = ?").bind(key).first<{ value: string | null }>();
  return r?.value ?? null;
}

export async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

export async function deleteState(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM sync_state WHERE key = ?").bind(key).run();
}
