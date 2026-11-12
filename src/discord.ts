// Discord REST API(DM・チャンネルへの送信とインタラクション応答の編集)。
const API = "https://discord.com/api/v10";

async function call(token: string, path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) throw new Error(`Discord API ${path} failed: ${res.status} ${await res.text()}`);
  return res;
}

export async function sendDm(token: string, userId: string, content: string): Promise<void> {
  const ch = (await (
    await call(token, "/users/@me/channels", { method: "POST", body: JSON.stringify({ recipient_id: userId }) })
  ).json()) as { id: string };
  await call(token, `/channels/${ch.id}/messages`, { method: "POST", body: JSON.stringify({ content }) });
}

/** チャンネルに投稿する。mentionUserId を渡すと先頭でメンションし、その人に通知が届くようにする。 */
export async function sendChannel(token: string, channelId: string, content: string, mentionUserId?: string): Promise<void> {
  const body = mentionUserId
    ? { content: `<@${mentionUserId}>\n${content}`, allowed_mentions: { users: [mentionUserId] } }
    : { content, allowed_mentions: { parse: [] } };
  await call(token, `/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify(body) });
}

/** 通知の送り先。channelId があればそのチャンネルにメンション付きで、無ければ DM で送る。 */
export function notifier(token: string, channelId: string | undefined): (userId: string, content: string) => Promise<void> {
  const ch = channelId?.trim();
  return ch && ch !== "REPLACE_ME"
    ? (userId, content) => sendChannel(token, ch, content, userId)
    : (userId, content) => sendDm(token, userId, content);
}

/** 遅延応答(type 5)したインタラクションの本文を差し替える。 */
export async function editOriginalResponse(appId: string, interactionToken: string, content: string): Promise<void> {
  const res = await fetch(`${API}/webhooks/${appId}/${interactionToken}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`edit original failed: ${res.status} ${await res.text()}`);
}
