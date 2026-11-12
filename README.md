# kadai-notification-bot

大学の課題の締切を、3日前から毎朝通知する個人用 Discord Bot です。通知先は指定したチャンネル(自分へのメンション付き)か DM を選べます。
Cloudflare Workers 上で動くので、Mac の電源が切れていても通知が届きます。

- スラッシュコマンド: Discord の Interactions Endpoint(HTTP)で Worker が受ける
- 毎朝の通知: Cron Trigger
- 保存先: Cloudflare D1

## 前提

- Cloudflare アカウント
- Discord Developer Portal でアプリケーションと Bot を作成済み(Bot をサーバーに招待し、scopes は `bot` と `applications.commands`)
- 通知先(下の「通知先の設定」):
  - チャンネルに送る場合は、Bot がそのチャンネルでメッセージを送信できること
  - DM で受け取る場合は、そのサーバーのプライバシー設定で「ダイレクトメッセージを許可」をオンにする
- Public Key は Developer Portal の「General Information」にある `PUBLIC KEY`。Application ID も同じ画面にある

## セットアップ

1. `npm install`
2. `npx wrangler login`
3. `npx wrangler d1 create kadai-db`(`database_id` を `wrangler.toml` に書く必要はありません。wrangler が名前で接続します。表示されたら「設定ファイルに追記するか」には No と答えてください)
4. `npx wrangler d1 migrations apply kadai-db --remote`
5. `npx wrangler queues create kadai-sync`(`/kadai sync` の実行に使うキュー。作成しないとデプロイできません)
6. シークレットを登録する(それぞれ値の入力を求められる)
   ```sh
   npx wrangler secret put DISCORD_TOKEN
   npx wrangler secret put DISCORD_PUBLIC_KEY
   npx wrangler secret put DISCORD_APPLICATION_ID
   ```
7. `npm run deploy`
8. 表示された Worker の URL を、Developer Portal の「General Information → Interactions Endpoint URL」に設定して保存(PING の署名検証が通れば保存できる)
9. `.dev.vars`(`.dev.vars.example` をコピー)に `DISCORD_TOKEN` / `DISCORD_APPLICATION_ID` / `GUILD_ID` を書いて `npm run register`

`GUILD_ID` を指定したギルドコマンドとして登録するので、すぐ反映されます。

## 通知先の設定

通知を送るチャンネルの ID をシークレットとして登録します(開発者モードをオンにしてチャンネルを右クリック →「チャンネルIDをコピー」)。登録するとすぐ反映されます。

```sh
npx wrangler secret put DISCORD_CHANNEL_ID
```

締切の通知と myFIT 取り込み失敗のお知らせが、そのチャンネルに自分へのメンション付きで投稿されます。
登録しない(または `npx wrangler secret delete DISCORD_CHANNEL_ID` で消す)と DM で送ります。

個人を特定できる値(ユーザー ID・チャンネル ID・myFIT の ID など)は、公開リポジトリに載らないよう `wrangler.toml` には書かず、すべてシークレットにしています。

## 通知時刻の変更

`wrangler.toml` の `[triggers] crons` を編集して再デプロイします。cron は UTC です。
cron は 2 本あり、1 本目が myFIT の取り込み(既定 05:30 JST)、2 本目が通知(既定 06:00 JST)です。取り込みは数分かかるので、通知より前に終わるよう時刻をずらしてください。
値を変えたら `src/cron.ts` の `CRON_SYNC` / `CRON_REMIND` も同じ値にしてください(`npm test` で一致を検証します)。

| 通知時刻(JST) | cron |
|---|---|
| 06:00(既定) | `0 21 * * *` |
| 08:00 | `0 23 * * *` |
| 07:30 | `30 22 * * *` |
| 21:00 | `0 12 * * *` |

## コマンド

返信はチャンネルの通常メッセージとして残ります(そのチャンネルを見られる人には見えるので、自分専用のサーバー・チャンネルで使ってください)。持ち主以外が `/kadai sync` を使ったときの拒否メッセージだけは本人にだけ表示されます。

- `/kadai add title deadline [course]` 課題登録。deadline は `YYYY-MM-DD HH:MM` または `YYYY-MM-DD`(23:59 扱い)。`/` 区切りも可。JST
- `/kadai list` 未完了の課題を締切順に表示
- `/kadai done id` 完了にする
- `/kadai delete id` 削除
- `/kadai notify` 定期通知と同じ内容を今すぐ通知先に送信(テスト用)
- `/kadai sync [unlock]` myFIT から今すぐ取り込む(持ち主のみ)。`unlock:true` は停止の解除(下記)

## myFIT 自動取り込み

福岡工業大学の myFIT(UNIPA)から、課題とテストの未提出分を毎朝 05:30 JST に自動で取り込みます。
Cloudflare Browser Rendering でログインして画面を読むため、**公式 API ではなく画面構成が変わると動かなくなります**。

- 主なデータ源は、クラスプロファイルの各授業にある「課題提出」「テスト」の一覧です。講義名・締切の時刻・提出状況が分かるので、ステータスが「受付中」で「未提出」が ○ の項目だけを取り込みます(1 回の取り込みは 2 分前後、授業の数に比例し、全体で 4 分程度を上限にします)
- ポータルトップの「期限あり」は全件を網羅しないため補助として読みます。授業の一覧に同じタイトルが無い項目だけを足し、期限は日付のみなのでその日の 23:59 扱い、講義名は不明です
- 取り込み結果に無い項目は提出済み(完了)にします。ただし一部の授業を読み込めなかった回は、誤って提出済みにしないよう、この判定を行いません(結果メッセージに注記が付きます)。手動で完了にしたものは再取り込みしても未完了に戻しません
- 同じ項目かどうかは「種別(課題/テスト)+タイトル」で判断します
- 表示は `[講義名] タイトル (課題)` / `(テスト)` の形式です。手動登録の課題は従来どおりです

### 設定

1. 自分の Discord ユーザー ID を調べる: Discord の「設定 → 詳細設定 → 開発者モード」をオンにし、自分のアイコンを右クリックして「ユーザーIDをコピー」
2. `npx wrangler secret put DISCORD_OWNER_ID` でそのIDを登録する(取り込み先・エラー通知の宛先・`/kadai sync` を使える人になります。登録しないと取り込みは動きません)
3. ID とパスワードを登録する。**自分のターミナルで自分で実行してください。AI アシスタントに渡したり、チャットに貼ったりしないでください**
   ```sh
   npx wrangler secret put MYFIT_ID
   npx wrangler secret put MYFIT_PASSWORD
   ```
4. マイグレーションを適用して再デプロイ: `npx wrangler d1 migrations apply kadai-db --remote` → `npm run deploy`
5. `npm run register` でコマンドを登録し直し、`/kadai sync` で試す

### リスク

- パスワードは **Microsoft 365 のアカウントのパスワード**です(myFIT は Microsoft のサインインを使います)。Cloudflare のシークレットに保存されます
- Microsoft が多要素認証(MFA)や追加の本人確認を求めたり、普段と違う場所からのサインインとしてブロックしたりすると、ログインできません。その場合は通知先でお知らせし、不審なサインインを毎日繰り返さないよう自動取り込みを停止します(確認後に `/kadai sync unlock:true` で解除)
- パスワードを間違えたまま試し続けるとアカウントがロックされる(5 回程度)ため、**パスワード誤りを検知した時点で自動取り込みを停止**し、cron も `/kadai sync` もログインを試みなくなります
- myFIT は同じ ID の同時ログインを警告します。取り込みの最後に必ずログアウトしますが、取り込み中(数分程度)に自分でログインしないでください

### 失敗したときの解除方法

1. お知らせの内容に従って原因を直す(パスワード誤りなら `npx wrangler secret put MYFIT_PASSWORD` で登録し直す)
2. パスワード誤りによる停止だけは、`/kadai sync unlock:true` で解除する(解除だけで取り込みはしません)
3. もう一度 `/kadai sync` を実行する

### 無料枠の制限

Browser Rendering の無料プランは **1 日あたり 10 分**まで、アイドル 60 秒でブラウザが閉じられます。
1 回の取り込みは 1 分前後なので、毎朝 1 回と手動の `/kadai sync` を数回行う程度なら収まります。
また Worker の CPU 時間は 1 回 10ms までなので、画面の解析はブラウザ内で行い、Worker は結果の JSON を受け取るだけにしています。

## 開発

```sh
npm test            # テスト(vitest)
npx tsc --noEmit    # 型チェック
npx wrangler deploy --dry-run
```
