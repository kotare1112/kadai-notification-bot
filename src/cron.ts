// Cron の識別子。wrangler.toml の [triggers] crons と同じ値にすること(test/cron.test.ts で検証)。
// 時刻は UTC。20:30 UTC = 翌 05:30 JST、21:00 UTC = 翌 06:00 JST。
// 取り込みは数分かかるので、通知より 30 分前に動かす。
export const CRON_SYNC = "30 20 * * *";
export const CRON_REMIND = "0 21 * * *";
