# PharmaStock JP

グループ薬局の在庫を店舗横断で見える化し、不動在庫の店舗間移動・納品遅延の把握・医薬品の供給状況の確認を支援する Web アプリです。

- 画面：React + TypeScript（Vite でビルド）
- データ：Supabase（データベース・ログイン）
- 公開：ビルドした `dist` フォルダを Xserver にアップロード

使い方（現場向けの操作手順）は、アプリ内の「マニュアル」画面（`components/Manual.tsx`）にまとめています。

---

## 主な機能

| 機能 | 画面（ファイル） | 内容 |
|---|---|---|
| 在庫照会 | `RealtimeSearch.tsx` | 全店舗の在庫・使用期限・ロット・出荷状況を横断検索 |
| 他店有・自店無 | `UnstockedCompare.tsx` | 自店にないが他店にある薬品と分譲希望数量の管理 |
| 発注・未納品管理 | `OrderManagement.tsx` | 発注CSVと入庫履歴を照合し、未納品・納品遅れを表示 |
| 納品ルール設定 | `OrderManagement.tsx` / `deliveryRule.ts` | 店舗の基本ルール＋卸ごとのルール（締め時刻・当日便・納品曜日・祝日） |
| 出荷状況インポート | `ShipmentStatusImport.tsx` / `shipmentMatch.ts` | 厚労省「医療用医薬品の供給状況」Excelを取込み、出荷調整・薬価削除予定を判定 |
| 入庫履歴・現在庫の同期 | `ExpiryImport.tsx` / `RealtimeStockImport.tsx` | レセコンのデータから在庫数と期限を更新 |
| 棚卸・不動在庫の整理 | `Dashboard.tsx` / `InventoryList.tsx` / `AdoptionCandidate.tsx` / `FinalDetermination.tsx` / `Import.tsx` | 不動在庫の仕分け・引受・移動指示書の印刷 |
| 店舗マスタ | `StoreMaster.tsx` | 店舗の追加・変更 |

---

## はじめての準備

### 1. 必要なもの

- [Node.js](https://nodejs.org/)（アプリのビルドに使う実行環境）
- Supabase のプロジェクト

### 2. 部品のインストール

```bash
npm install
```

### 3. 接続設定ファイル `.env.local` を作る

プロジェクトの一番上のフォルダに `.env.local` を作り、Supabase の管理画面「Project Settings → API」の値を入れます。

```env
VITE_SUPABASE_URL=https://xxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=（anon public キー）
```

> **注意**
> - `.env.local` は GitHub に送らない設定になっています（`.gitignore` の `*.local`）。GitHub から取り込んだだけのフォルダにはないので、別のパソコンで作業するときは作り直してください。
> - このファイルがない状態でビルドすると、本番で「supabaseUrl is required」となり画面が表示されません。
> - `service_role` キー（管理者用の強いキー）は、`VITE_` を付けて書かないでください。`VITE_` 付きの値は画面のファイルに埋め込まれ、誰でも見られる状態になります。

### 4. データベースの表を作る（最初に一度だけ）

Supabase の「SQL Editor」で、次のファイルの中身をそれぞれ貼り付けて実行します。

| ファイル | 作られる表 | 使う機能 |
|---|---|---|
| `supabase/shipment_status.sql` | `shipment_status` | 出荷状況インポート |
| `supabase/orders.sql` | `orders` | 発注・未納品管理 |
| `supabase/ignored_order_items.sql` | `ignored_order_items` | 発注の除外マスタ |
| `supabase/delivery_rules.sql` | `delivery_rules` | 納品ルール（店舗・卸別・当日便） |

どのファイルも、何度実行しても問題ない書き方になっています。

---

## 手元で動かす

```bash
npm run dev
```

ブラウザで `http://localhost:3000` を開きます。

> 手元で動かしても、つながるデータベースは本番と同じです。保存や照合を実行すると本番のデータが変わります。

---

## 本番（Xserver）への公開

1. ビルドします（アプリを公開用のファイルにまとめる作業）。

   ```bash
   npm run build
   ```

2. できあがった `dist` フォルダの**中身**（`index.html` と `assets` フォルダ）を Xserver の公開フォルダにアップロードします。
3. 本番のページを開き、ログイン画面が出ること、ブラウザのコンソールに `supabaseUrl is required` が出ていないことを確認します。

> ビルドは `.env.local` があるフォルダで行ってください。
> 公開前の `dist` は、別名のフォルダ（例：`dist_backup_日付`）にコピーしておくと、問題があったときにすぐ戻せます。

---

## フォルダ構成

```
├─ components/          各画面
├─ supabase/            データベースの表を作るSQL・Edge Function
├─ App.tsx              画面の切り替え・全体の状態
├─ supabase.ts          Supabase への接続
├─ types.ts             データの型定義
├─ shipmentMatch.ts     出荷状況の突合・バッジ判定（出荷調整／薬価削除予定）
├─ orderMatch.ts        発注CSVの読込・入庫履歴との照合
├─ deliveryRule.ts      予定納品日の計算・納品ルールの保存
├─ ExpiryAnalysis.ts    使用期限の分析
├─ CHANGELOG.txt        変更履歴（新しいものほど上）
└─ backups/             過去バージョンの控え（ビルドには使われません）
```

---

## GitHub への反映

- 変更内容は `CHANGELOG.txt` の一番上に追記します。
- コミットのメールアドレスは、GitHub の非公開設定に合わせて `…@users.noreply.github.com` を使います（実際のアドレスだとプッシュが拒否されます）。

```bash
git config user.email "（GitHubアカウントのnoreplyアドレス）"
```
