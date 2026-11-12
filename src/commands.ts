// /kadai サブコマンドのハンドラ。戻り値は応答メッセージ本文。
import * as db from "./db.ts";
import { buildMessage, daysLeft, formatDeadline, formatName, parseDeadline, selectDue } from "./reminder.ts";

export type Options = Record<string, string | number | boolean | undefined>;

export async function add(d1: D1Database, userId: string, o: Options, now: number): Promise<string> {
  let dl: number;
  try {
    dl = parseDeadline(String(o.deadline ?? ""), now);
  } catch (e) {
    return `❌ ${(e as Error).message}`;
  }
  const course = o.course ? String(o.course) : null;
  const id = await db.add(d1, userId, String(o.title ?? ""), dl, course, now);
  return `✅ 登録しました (ID: ${id})\n締切: ${formatDeadline(dl)}`;
}

export async function list(d1: D1Database, userId: string, now: number): Promise<string> {
  const items = await db.listPending(d1, userId);
  if (items.length === 0) return "未完了の課題はありません 🎉";
  return items
    .map((a) => {
      const n = daysLeft(a.deadline, now);
      const remain = a.deadline < now ? "期限切れ" : n > 0 ? `あと${n}日` : "今日まで";
      return `\`${a.id}\` ${formatName(a)} — ${formatDeadline(a.deadline)} (${remain})`;
    })
    .join("\n");
}

export async function done(d1: D1Database, userId: string, o: Options): Promise<string> {
  const id = Number(o.id);
  return (await db.markDone(d1, userId, id)) ? `✅ ID ${id} を完了にしました` : `❌ ID ${id} の課題が見つかりません`;
}

export async function del(d1: D1Database, userId: string, o: Options): Promise<string> {
  const id = Number(o.id);
  return (await db.remove(d1, userId, id)) ? `🗑️ ID ${id} を削除しました` : `❌ ID ${id} の課題が見つかりません`;
}

/** notify: 送信(DM またはチャンネル)は send で注入(遅延応答の後に実行される)。 */
export async function notify(
  d1: D1Database,
  userId: string,
  now: number,
  send: (content: string) => Promise<void>,
): Promise<string> {
  const items = selectDue(await db.listPending(d1, userId), now);
  if (items.length === 0) return "通知する課題はありません";
  try {
    await send(buildMessage(items, now));
  } catch (e) {
    console.error("notify failed", e);
    return "❌ 通知を送れませんでした。DM の受信設定、または通知先チャンネルで Bot がメッセージを送れるかを確認してください";
  }
  return "📨 通知を送信しました";
}
