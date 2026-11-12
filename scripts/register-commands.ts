// /kadai コマンド定義をギルドに登録する。npm run register
import { existsSync, readFileSync } from "node:fs";

function loadEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

const env = { ...loadEnv(".env"), ...loadEnv(".dev.vars"), ...process.env };
const { DISCORD_TOKEN, DISCORD_APPLICATION_ID, GUILD_ID } = env;
if (!DISCORD_TOKEN || !DISCORD_APPLICATION_ID || !GUILD_ID) {
  console.error("DISCORD_TOKEN / DISCORD_APPLICATION_ID / GUILD_ID を .dev.vars に設定してください");
  process.exit(1);
}

const STRING = 3;
const INTEGER = 4;
const BOOLEAN = 5;
const command = {
  name: "kadai",
  description: "課題の締切管理",
  options: [
    {
      type: 1,
      name: "add",
      description: "課題を登録します",
      options: [
        { type: STRING, name: "title", description: "課題名", required: true },
        {
          type: STRING,
          name: "deadline",
          description: "締切 (YYYY-MM-DD HH:MM または YYYY-MM-DD。日付のみは 23:59)",
          required: true,
        },
        { type: STRING, name: "course", description: "科目名(任意)", required: false },
      ],
    },
    { type: 1, name: "list", description: "未完了の課題を締切順に表示します" },
    {
      type: 1,
      name: "done",
      description: "課題を完了にします",
      options: [{ type: INTEGER, name: "id", description: "課題ID", required: true }],
    },
    {
      type: 1,
      name: "delete",
      description: "課題を削除します",
      options: [{ type: INTEGER, name: "id", description: "課題ID", required: true }],
    },
    {
      type: 1,
      name: "sync",
      description: "myFIT から課題・テストを今すぐ取り込みます(持ち主のみ)",
      options: [
        {
          type: BOOLEAN,
          name: "unlock",
          description: "パスワード誤りによる自動取り込みの停止を解除します(取り込みは行いません)",
          required: false,
        },
      ],
    },
    { type: 1, name: "notify", description: "定期通知と同じ DM を今すぐ送ります(テスト用)" },
  ],
};

const res = await fetch(
  `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${GUILD_ID}/commands`,
  {
    method: "PUT",
    headers: { Authorization: `Bot ${DISCORD_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify([command]),
  },
);
if (!res.ok) {
  console.error(`登録に失敗しました: ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log("コマンドを登録しました");
