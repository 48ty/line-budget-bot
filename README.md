# LINE 残り予算管理Bot

LINEで支出を送るだけで、設定した期間の「あといくら使えるか」を返す個人用Botです。

## 機能

- 予算設定：`今日から月末まで30000円`
- 支出登録：`コンビニ 600円`
- 確認コマンド：`残り` / `今日` / `一覧`
- リセット：`リセット` のあと `はい` で確定
- Webhook疎通確認：`GET /health`
- Google Sheets保存
- LINE Webhook署名検証
- OpenAI APIによる自然文解析

## ファイル構成

```text
.
├── package.json
├── server.js
├── lib
│   ├── budget.js
│   ├── line.js
│   ├── openai.js
│   └── sheets.js
├── .env.example
└── README.md
```

## 必要な環境変数

`.env.example` を参考に `.env` を作成します。

```env
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
OPENAI_API_KEY=
OPENAI_ENABLED=false
SPREADSHEET_ID=
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=
SHEETS_WEBAPP_URL=
SHEETS_WEBAPP_SECRET=
PORT=3000
```

`GOOGLE_PRIVATE_KEY` は改行を `\n` に置き換えて1行で設定できます。

無料運用したい場合は `OPENAI_ENABLED=false` のままにしてください。この状態ではOpenAI APIを呼ばず、ローカル解析だけで動きます。

サービスアカウントキーを作れない場合は、`SHEETS_WEBAPP_URL` と `SHEETS_WEBAPP_SECRET` を使うGoogle Apps Script方式で動かせます。その場合、`GOOGLE_SERVICE_ACCOUNT_EMAIL` と `GOOGLE_PRIVATE_KEY` は空欄でOKです。

## ローカルで動かす

```bash
npm install
cp .env.example .env
npm run dev
```

起動後、疎通確認します。

```bash
curl http://localhost:3000/health
```

LINEのWebhookとして使うには、ローカルサーバーを外部公開する必要があります。開発時は ngrok などで `http://localhost:3000` を公開し、Webhook URLに `https://xxxx.ngrok-free.app/webhook` を設定してください。

## LINE Developersの設定

1. [LINE Developers Console](https://developers.line.biz/console/) を開きます。
2. プロバイダーを作成します。
3. `Messaging API` チャネルを作成します。
4. チャネルの `Messaging API設定` を開きます。
5. `チャネルアクセストークン（長期）` を発行し、`LINE_CHANNEL_ACCESS_TOKEN` に設定します。
6. `チャネル基本設定` の `チャネルシークレット` を `LINE_CHANNEL_SECRET` に設定します。
7. `Webhook URL` に `https://あなたのドメイン/webhook` を設定します。
8. `Webhookの利用` をオンにします。
9. 必要に応じて `応答メッセージ` をオフにします。

## OpenAI APIキーの設定

1. [OpenAI Platform](https://platform.openai.com/) でAPIキーを作成します。
2. 作成したキーを `OPENAI_API_KEY` に設定します。
3. モデルを変えたい場合は任意で `OPENAI_MODEL` を設定します。未設定時は `gpt-4o-mini` を使います。

## Google Sheets APIの設定

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成します。
2. `Google Sheets API` を有効化します。
3. `IAMと管理` → `サービスアカウント` を開きます。
4. サービスアカウントを作成します。
5. 作成したサービスアカウントのメールアドレスを `GOOGLE_SERVICE_ACCOUNT_EMAIL` に設定します。
6. `キー` → `鍵を追加` → `新しい鍵を作成` → `JSON` を選びます。
7. JSON内の `private_key` を `GOOGLE_PRIVATE_KEY` に設定します。
8. Googleスプレッドシートを作成し、URL内のIDを `SPREADSHEET_ID` に設定します。
9. そのスプレッドシートをサービスアカウントのメールアドレスに `編集者` 権限で共有します。

## サービスアカウントキーを作れない場合

Google Cloudで `iam.disableServiceAccountKeyCreation` が出る場合は、Google Apps Script方式を使ってください。JSONキーなしでGoogle Sheetsに保存できます。

1. 作成済みのスプレッドシートを開きます。
2. メニューの `拡張機能` → `Apps Script` を開きます。
3. [google-apps-script/Code.gs](./google-apps-script/Code.gs) の中身をApps Scriptエディタへ貼り付けます。
4. 先頭付近の `CHANGE_ME_TO_A_RANDOM_SECRET` を好きな長い文字列に変えます。

例：

```js
const SECRET = "my-long-random-secret-12345";
```

5. `デプロイ` → `新しいデプロイ` を押します。
6. 種類で `ウェブアプリ` を選びます。
7. `次のユーザーとして実行` は `自分` を選びます。
8. `アクセスできるユーザー` は `全員` を選びます。
9. `デプロイ` を押します。
10. 初回は権限確認が出るので許可します。
11. 表示された `ウェブアプリ URL` を `SHEETS_WEBAPP_URL` に設定します。
12. 手順4で決めた文字列を `SHEETS_WEBAPP_SECRET` に設定します。

この方式では、`.env` は次のようになります。

```env
SPREADSHEET_ID=スプレッドシートID
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=
SHEETS_WEBAPP_URL=https://script.google.com/macros/s/xxxxx/exec
SHEETS_WEBAPP_SECRET=my-long-random-secret-12345
```

初回アクセス時に以下のシートがなければ自動作成します。

### budgets

| userId | startDate | endDate | totalBudget | createdAt | updatedAt |
| --- | --- | --- | --- | --- | --- |

### expenses

| userId | date | itemName | amount | rawMessage | createdAt |
| --- | --- | --- | --- | --- | --- |

## Renderにデプロイする

1. GitHubにこのプロジェクトをpushします。
2. [Render](https://render.com/) で `New` → `Web Service` を選びます。
3. リポジトリを接続します。
4. Runtimeは `Node` を選びます。
5. Build Commandを設定します。

```bash
npm install
```

6. Start Commandを設定します。

```bash
npm start
```

7. Environment Variablesに `.env.example` と同じ変数を登録します。
8. デプロイ後、`https://あなたのRender URL/health` が `{"ok":true}` を返すことを確認します。
9. LINE DevelopersのWebhook URLに `https://あなたのRender URL/webhook` を設定します。

## LINEでの使い方

### 予算設定

```text
7/1〜7/31 予算50000円で開始
今日から月末まで30000円
6/21から6/30まで予算10000円
```

返信例：

```text
予算を設定しました。
期間：7/1〜7/31
総予算：50,000円
1日あたり：約1,613円
```

### 支出登録

```text
コンビニ 600円
昼飯850円
電車 220円
カフェで500円
スーパー 1340円
```

返信例：

```text
記録しました。
コンビニ：600円

今日の支出：600円
合計支出：600円
残り予算：49,400円
残り日数：30日
1日あたり使える金額：約1,646円
```

### コマンド

```text
残り
今日
一覧
リセット
ヘルプ
```

## エラー時の返信

- 予算未設定：予算設定例を返します。
- 金額不明：支出入力例を返します。
- 期間終了：新しい予算設定を促します。
- Google Sheets保存失敗：処理エラーとして再試行を案内します。
- OpenAI解析失敗：入力例とヘルプ案内を返します。

## 注意

- MVPのため、通貨は円のみです。
- テキスト入力のみ対応しています。
- レシート画像読み取り、グラフ、カテゴリ分類は未実装です。
- リセット確認状態はサーバーのメモリで管理しています。Renderの再起動や複数インスタンスでは確認状態が消える場合があります。
