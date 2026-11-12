// myFIT 取り込みの司令塔。ロック判定・スクレイプ・DB 反映・結果の記録を行う。
// 失敗したログインは自動で再試行しない(パスワード誤りが 5 回続くとアカウントがロックされるため)。
import * as db from "./db.ts";
import { MyfitError, type MyfitCredentials, type MyfitErrorCode } from "./myfit/errors.ts";
import type { RawItem } from "./myfit/extract.ts";
import { toSyncItems, type SyncCounts } from "./myfit/sync.ts";

export const LOCK_KEY = "myfit_locked";
export const LAST_RESULT_KEY = "myfit_last_result";
export const RUNNING_KEY = "myfit_running";
// 実行中フラグがこれより古ければ、異常終了で残ったものとみなして無視する
export const RUNNING_TTL_MS = 5 * 60 * 1000;
// 人が確認するまで自動ログインを止める失敗(パスワード誤り・不審なサインインとして扱われたもの)
const LOCKING_CODES: MyfitErrorCode[] = ["bad_password", "mfa_required", "blocked"];

export interface SyncEnv {
  DB: D1Database;
  DISCORD_OWNER_ID?: string;
  MYFIT_ID?: string;
  MYFIT_PASSWORD?: string;
}

export type SyncFailure = MyfitErrorCode | "locked" | "not_configured" | "busy";

export type SyncOutcome = { ok: true; counts: SyncCounts; complete: boolean } | { ok: false; code: SyncFailure };

/** complete は、すべての授業の一覧を読めたか。false のときは提出済みの判定をしない。 */
export interface ScrapeResult {
  items: RawItem[];
  complete: boolean;
}

export type Scraper = (cred: MyfitCredentials) => Promise<ScrapeResult>;

/** 未設定またはプレースホルダのままなら null。 */
export function ownerId(env: SyncEnv): string | null {
  const id = env.DISCORD_OWNER_ID?.trim();
  return id && id !== "REPLACE_ME" ? id : null;
}

export async function runSync(env: SyncEnv, scrape: Scraper, now: number): Promise<SyncOutcome> {
  const owner = ownerId(env);
  if (!owner || !env.MYFIT_ID || !env.MYFIT_PASSWORD) return { ok: false, code: "not_configured" };
  if ((await db.getState(env.DB, LOCK_KEY)) === "1") return { ok: false, code: "locked" };

  const started = Number(await db.getState(env.DB, RUNNING_KEY));
  if (started && now - started < RUNNING_TTL_MS) return { ok: false, code: "busy" };
  await db.setState(env.DB, RUNNING_KEY, String(now));

  try {
    const { items, complete } = await scrape({ id: env.MYFIT_ID, password: env.MYFIT_PASSWORD });
    const counts = await db.applyMyfitSync(env.DB, owner, toSyncItems(items), now, complete);
    await db.setState(env.DB, LAST_RESULT_KEY, JSON.stringify({ at: now, ok: true, complete, ...counts }));
    return { ok: true, counts, complete };
  } catch (e) {
    const code: MyfitErrorCode = e instanceof MyfitError ? e.code : "unknown";
    if (LOCKING_CODES.includes(code)) await db.setState(env.DB, LOCK_KEY, "1");
    await db.setState(env.DB, LAST_RESULT_KEY, JSON.stringify({ at: now, ok: false, code }));
    if (!(e instanceof MyfitError)) console.error("myfit sync failed", (e as Error)?.name);
    return { ok: false, code };
  } finally {
    await db.deleteState(env.DB, RUNNING_KEY);
  }
}

/** キューに積む手動取り込みのメッセージ */
export interface ManualSyncMessage {
  type: "manual_sync";
  interactionToken: string;
  unlock?: never;
}

export function syncResultText(r: SyncOutcome): string {
  return r.ok ? `✅ ${describeSuccess(r.counts, r.complete)}` : `❌ ${describeFailure(r.code)}`;
}

/**
 * キューの 1 メッセージを処理する。結果で元の応答を差し替え、必ず ack する(自動再試行でログインし直さないため)。
 */
export async function processManualSync(
  msg: { body: ManualSyncMessage; ack(): void },
  run: () => Promise<SyncOutcome>,
  edit: (token: string, content: string) => Promise<unknown>,
): Promise<void> {
  try {
    const text = syncResultText(await run());
    try {
      await edit(msg.body.interactionToken, text);
    } catch (e) {
      console.error("sync reply failed", (e as Error)?.name);
    }
  } catch (e) {
    console.error("manual sync failed", (e as Error)?.name);
  } finally {
    msg.ack();
  }
}

export async function unlock(d1: D1Database): Promise<void> {
  await db.deleteState(d1, LOCK_KEY);
}

const REREGISTER =
  "`npx wrangler secret put MYFIT_PASSWORD` でパスワードを登録し直してから、`/kadai sync unlock:true` で停止を解除してください。";

export function describeFailure(code: SyncFailure): string {
  switch (code) {
    case "bad_password":
      return `myFIT のパスワードが違うため自動取り込みを停止しました(アカウントのロックを避けるため再試行しません)。${REREGISTER}`;
    case "locked":
      return `前回のログイン失敗のため myFIT の自動取り込みを停止中です。原因を確認してから \`/kadai sync unlock:true\` で解除してください(パスワード誤りだった場合は先に \`npx wrangler secret put MYFIT_PASSWORD\` で登録し直してください)。`;
    case "mfa_required":
      return "Microsoft が追加の本人確認を要求したためログインできず、自動取り込みを停止しました。ブラウザで一度サインインして状況を確認してから `/kadai sync unlock:true` で解除してください。";
    case "blocked":
      return "Microsoft にサインインをブロックされたため、自動取り込みを停止しました。ブラウザで Microsoft アカウントの状態を確認してから `/kadai sync unlock:true` で解除してください。";
    case "timeout":
      return "myFIT へのログインまたは画面の読み込みがタイムアウトしました。時間をおいて `/kadai sync` を試してください。";
    case "layout_changed":
      return "myFIT の画面構成が変わった可能性があります。課題・テストの一覧を取得できませんでした。スクレイパーの修正が必要かもしれません。";
    case "not_configured":
      return "myFIT の取り込みが未設定です。シークレット `DISCORD_OWNER_ID` / `MYFIT_ID` / `MYFIT_PASSWORD` を登録してください。";
    case "busy":
      return "別の取り込みが実行中です。少し待ってから試してください。";
    default:
      return "myFIT の取り込み中に予期しないエラーが発生しました。";
  }
}

export function describeSuccess(c: SyncCounts, complete = true): string {
  const base = `myFIT の未提出: ${c.total}件(新規 ${c.added}件 / 更新 ${c.updated}件 / 提出済み ${c.completed}件)`;
  return complete ? base : `${base}\n※一部の授業を読み込めなかったため、提出済みの判定は行っていません`;
}
