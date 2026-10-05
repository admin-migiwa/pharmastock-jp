-- 出荷調整状況（厚労省「医療用医薬品の供給状況」）テーブル
-- Supabase の SQL Editor で一度だけ実行してください。
-- 全店共通のマスタ。出荷状況インポート画面から全置換方式で更新されます。

create table if not exists public.shipment_status (
  yj_code        text primary key,          -- ⑤YJコード（薬価基準コード12桁）
  name           text not null,             -- ⑥品名
  name_key       text not null,             -- 照合用の正規化品名（コードなし店舗の名称照合に使用）
  maker          text,                      -- ⑦製造販売業者名
  status         text not null,             -- ⑫出荷対応の状況
  status_date    date,                      -- ⑬⑫の更新日
  reason         text,                      -- ⑭限定出荷/供給停止の理由
  outlook        text,                      -- ⑮解除/解消見込み
  outlook_detail text,                      -- ⑯解除/解消見込み時期（在庫消尽時期）
  volume_status  text,                      -- ⑰出荷量の現在の状況
  volume_outlook text,                      -- ⑱出荷量の改善見込み時期
  volume_amount  text,                      -- ⑲出荷量の改善見込み量
  info_date      date,                      -- ⑳⑫以外の更新日
  is_new         boolean not null default false, -- 今回掲載時の更新有無（New）
  is_adjusting   boolean not null default false, -- 出荷調整中（通常出荷以外／出荷量減少・停止等）
  source_file    text,                      -- 取込ファイル名
  imported_at    timestamptz not null default now()
);

create index if not exists shipment_status_name_key_idx on public.shipment_status (name_key);
create index if not exists shipment_status_adjusting_idx on public.shipment_status (is_adjusting);

alter table public.shipment_status enable row level security;

-- ログイン済みの全ユーザーが参照・更新可能（全店が取込可能）
drop policy if exists "shipment_status_select" on public.shipment_status;
create policy "shipment_status_select" on public.shipment_status
  for select to authenticated using (true);

drop policy if exists "shipment_status_insert" on public.shipment_status;
create policy "shipment_status_insert" on public.shipment_status
  for insert to authenticated with check (true);

drop policy if exists "shipment_status_update" on public.shipment_status;
create policy "shipment_status_update" on public.shipment_status
  for update to authenticated using (true) with check (true);

drop policy if exists "shipment_status_delete" on public.shipment_status;
create policy "shipment_status_delete" on public.shipment_status
  for delete to authenticated using (true);
