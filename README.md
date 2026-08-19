# エリアトラッカー

訪問営業・エリア調査向けのマップ管理SaaS。CSVから住所を自動ジオコーディングし、現場スタッフがマップ上で訪問状況・見込み度を記録できる。

## 構成

- [`index.html`](index.html) — 現場用マップアプリ（フロントエンド）。Cloudflare Pages等の静的ホスティングにデプロイする。
- [`admin.html`](admin.html) — 運営者用の新規顧客登録画面。管理者パスワードで保護されている。
- [`gas/Code.gs`](gas/Code.gs) — バックエンドAPI（Google Apps Script）。顧客登録・CSV取り込み・認証・ステータス更新を担当。Google Apps Scriptとしてデプロイする（Cloudflareでは動作しない）。
- `config.example.js` — フロントエンド設定のテンプレート。
- `config.js` — 実際のAPIキー・GAS URLを入れる設定ファイル（**Git管理外**。`.gitignore`で除外済み）。

## セットアップ

### 1. バックエンド（Google Apps Script）

1. [script.google.com](https://script.google.com) で新規プロジェクトを作成し、[`gas/Code.gs`](gas/Code.gs) の内容を貼り付ける。
2. エディタ左側「プロジェクトの設定」(⚙) →「スクリプト プロパティ」で以下を登録する。
   - `MASTER_SHEET_ID` — 顧客マスタを管理するスプレッドシートのID
   - `GOOGLE_API_KEY` — ジオコーディング用のGoogle Maps APIキー
   - `PARENT_FOLDER_ID` — 顧客シートの保存先GoogleドライブフォルダID
   - `FIELD_APP_URL` — 現場用マップアプリ（index.html）の公開URL
   - `ADMIN_PASSWORD` — 新規顧客登録画面（admin.html）用の管理者パスワード
3. 「デプロイ」→「新しいデプロイ」→ ウェブアプリとして公開し、実行URL（`.../exec`）を控える。

### 2. フロントエンド（index.html）

1. `config.example.js` を `config.js` としてコピーする。
2. `config.js` の値を実際のものに書き換える。
   - `GOOGLE_API_KEY` — Google Maps **JavaScript** APIキー（HTTPリファラー制限を必ずかけること）
   - `CONFIG_GAS_URL` — 上記手順3で控えたGASの実行URL
3. ブラウザで `index.html` を直接開けば動作確認できる。

## デプロイ（Cloudflare Pages）

`config.js` はGit管理外のため、GitHub連携の自動デプロイでは同梱されない。`wrangler` CLIでローカルから直接デプロイする。

```bash
npx wrangler login
npx wrangler pages project create area-tracker

# デプロイ用フォルダに公開対象ファイルのみ集めてからデプロイ
mkdir -p dist
cp index.html admin.html config.js dist/
npx wrangler pages deploy dist --project-name area-tracker
```

初回 `wrangler login` はブラウザでのCloudflareアカウント認証が必要。

## セキュリティ上の注意

- Google Maps JavaScript APIキーはブラウザに公開される前提の仕組み。Google Cloud Consoleで**HTTPリファラー制限**を必ず設定すること。
- `update_status` アクションは現状、ログイン後の`sheetId`のみで認可しており、セッション再認証は行っていない。
- 顧客パスワードは平文でスプレッドシートに保存・メール送信される。運用上のリスクとして認識しておくこと。
- `admin.html`は同じ公開ドメインに置かれるため誰でもアクセス自体は可能。`ADMIN_PASSWORD`はサーバー側（GAS）で検証されるが、より厳重にするならCloudflare Access等でパス自体へのアクセス制限を追加するとよい。
