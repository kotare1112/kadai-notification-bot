import { verifyKey } from "discord-interactions";
import * as cmd from "./commands.ts";
import * as db from "./db.ts";
import { CRON_REMIND, CRON_SYNC } from "./cron.ts";
import { editOriginalResponse, notifier } from "./discord.ts";
import { scrapeMyfit } from "./myfit/scrape.ts";
import { buildMessage, selectDue } from "./reminder.ts";
import { describeFailure, LOCK_KEY, ownerId, processManualSync, runSync, unlock, type ManualSyncMessage } from "./sync.ts";

export interface Env {
  DB: D1Database;
  DISCORD_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  /** シークレット。自分の Discord ユーザー ID */
  DISCORD_OWNER_ID?: string;
  /** シークレット。通知を送るチャンネルの ID。未登録なら DM で送る */
  DISCORD_CHANNEL_ID?: string;
  BROWSER: Fetcher;
  SYNC_QUEUE: Queue<ManualSyncMessage>;
  MYFIT_ID?: string;
  MYFIT_PASSWORD?: string;
}

interface Option {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: Option[];
}

interface Interaction {
  type: number;
  token: string;
  member?: { user: { id: string } };
  user?: { id: string };
  data?: { name: string; options?: Option[] };
}

// 返信はチャンネルの通常メッセージにする(ephemeral だと Discord を閉じると消えるため)。
// 持ち主以外への拒否メッセージだけは本人にだけ見せる。
const EPHEMERAL = 64;
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const reply = (content: string) => json({ type: 4, data: { content } });
const replyPrivate = (content: string) => json({ type: 4, data: { content, flags: EPHEMERAL } });
const deferReply = () => json({ type: 5 });

async function handleInteraction(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const signature = req.headers.get("X-Signature-Ed25519");
  const timestamp = req.headers.get("X-Signature-Timestamp");
  const body = await req.text();
  if (!signature || !timestamp || !(await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY))) {
    return new Response("invalid request signature", { status: 401 });
  }

  const it = JSON.parse(body) as Interaction;
  if (it.type === 1) return json({ type: 1 }); // PING -> PONG
  if (it.type !== 2 || it.data?.name !== "kadai") return new Response("unsupported", { status: 400 });

  const userId = it.member?.user.id ?? it.user?.id;
  const sub = it.data.options?.[0];
  if (!userId || !sub) return new Response("bad request", { status: 400 });
  const o: cmd.Options = Object.fromEntries((sub.options ?? []).map((x) => [x.name, x.value]));
  const now = Date.now();

  switch (sub.name) {
    case "add":
      return reply(await cmd.add(env.DB, userId, o, now));
    case "list":
      return reply(await cmd.list(env.DB, userId, now));
    case "done":
      return reply(await cmd.done(env.DB, userId, o));
    case "delete":
      return reply(await cmd.del(env.DB, userId, o));
    case "notify":
      // 送信は 3 秒を超え得るので遅延応答し、完了後に本文を差し替える
      ctx.waitUntil(
        (async () => {
          const send = notifier(env.DISCORD_TOKEN, env.DISCORD_CHANNEL_ID);
          const msg = await cmd.notify(env.DB, userId, now, (c) => send(userId, c));
          await editOriginalResponse(env.DISCORD_APPLICATION_ID, it.token, msg);
        })().catch((e) => console.error("notify failed", e)),
      );
      return deferReply();
    case "sync": {
      if (userId !== ownerId(env)) return replyPrivate("❌ このコマンドは Bot の持ち主だけが使えます");
      if (o.unlock === true) {
        await unlock(env.DB);
        return reply("🔓 停止を解除しました。パスワードを登録し直したことを確認して、もう一度 `/kadai sync` を実行してください");
      }
      // 事前チェック: ロック中・未設定ならキューに積まず即エラーを返す
      if (!ownerId(env) || !env.MYFIT_ID || !env.MYFIT_PASSWORD) return reply(`❌ ${describeFailure("not_configured")}`);
      if ((await db.getState(env.DB, LOCK_KEY)) === "1") return reply(`❌ ${describeFailure("locked")}`);
      // ログインは fetch の waitUntil(約 30 秒で打ち切り)に収まらないのでキューで実行し、遅延応答を後で差し替える
      try {
        await env.SYNC_QUEUE.send({ type: "manual_sync", interactionToken: it.token } satisfies ManualSyncMessage);
      } catch (e) {
        console.error("sync enqueue failed", (e as Error)?.name);
        return reply("❌ 取り込みの受付に失敗しました。少し待ってからもう一度試してください");
      }
      return deferReply();
    }
    default:
      return new Response("unknown subcommand", { status: 400 });
  }
}

async function sendReminders(env: Env, now: number): Promise<void> {
  const byUser = new Map<string, Awaited<ReturnType<typeof db.listPending>>>();
  for (const a of selectDue(await db.listPending(env.DB), now)) {
    byUser.set(a.user_id, [...(byUser.get(a.user_id) ?? []), a]);
  }
  const send = notifier(env.DISCORD_TOKEN, env.DISCORD_CHANNEL_ID);
  for (const [userId, items] of byUser) {
    try {
      await send(userId, buildMessage(items, now));
    } catch (e) {
      console.error(`通知の送信に失敗しました: user_id=${userId}`, e);
    }
  }
}

/** 定時の取り込み。成功時は何も送らず、失敗時だけ持ち主に知らせる。ロック中・未設定・他の取り込みが実行中のときは静かに何もしない。 */
async function syncMyfit(env: Env, now: number): Promise<void> {
  const owner = ownerId(env);
  if (!owner) return;
  const r = await runSync(env, (cred) => scrapeMyfit(env.BROWSER, cred), now);
  if (r.ok || r.code === "locked" || r.code === "not_configured" || r.code === "busy") return;
  try {
    await notifier(env.DISCORD_TOKEN, env.DISCORD_CHANNEL_ID)(owner, `⚠️ ${describeFailure(r.code)}`);
  } catch (e) {
    console.error("エラー通知の送信に失敗しました", e);
  }
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    if (req.method !== "POST") return new Response("kadai-notification-bot", { status: 200 });
    return handleInteraction(req, env, ctx);
  },
  async queue(batch, env): Promise<void> {
    for (const msg of batch.messages) {
      await processManualSync(
        msg,
        () => runSync(env, (cred) => scrapeMyfit(env.BROWSER, cred), Date.now()),
        (token, content) => editOriginalResponse(env.DISCORD_APPLICATION_ID, token, content),
      );
    }
  },
  async scheduled(event, env, ctx): Promise<void> {
    switch (event.cron) {
      case CRON_SYNC:
        ctx.waitUntil(syncMyfit(env, event.scheduledTime));
        break;
      case CRON_REMIND:
        ctx.waitUntil(sendReminders(env, event.scheduledTime));
        break;
      default:
        console.error(`未知の cron です: ${event.cron}`);
    }
  },
} satisfies ExportedHandler<Env, ManualSyncMessage>;
