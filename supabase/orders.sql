-- 発注・未納品管理テーブル
-- Supabase の SQL Editor で実行してください。

create table if not exists public.orders (
  id                   uuid primary key default gen_random_uuid(),
  store_id             uuid not null,                     -- 店舗ID
  order_date           date not null,                     -- 発注日
  order_time           text,                              -- 発注時刻 (16:19:28等)
  delivery_date        date not null,                     -- 納品指定日
  actual_delivery_date date,                              -- 実際の納品確認日
  delay_days           integer,                           -- 納品遅れ日数 (actual_delivery_date - delivery_date)
  jan_code             text not null,                     -- 商品コード (JAN 13桁)
  yakka_code           text,                              -- 薬価コード
  name                 text not null,                     -- 品名
  name_key             text not null,                     -- 照合用正規化品名
  spec                 text,                              -- 規格容量
  maker                text,                              -- メーカー名
  supplier             text,                              -- 発注先卸名
  order_qty            integer not null default 1,        -- 発注数量 (箱数)
  delivered_qty        integer not null default 0,        -- 納品確認済み数量 (箱数換算)
  status               text not null default 'pending',   -- pending / partial / fulfilled / delayed / cancelled
  source_file          text,                              -- 発注インポートファイル名
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists orders_store_id_idx on public.orders (store_id);
create index if not exists orders_order_date_idx on public.orders (order_date);
create index if not exists orders_jan_code_idx on public.orders (jan_code);
create index if not exists orders_status_idx on public.orders (status);

alter table public.orders enable row level security;

-- ログイン済みの全ユーザーが参照・操作可能
drop policy if exists "orders_select" on public.orders;
create policy "orders_select" on public.orders
  for select to authenticated using (true);

drop policy if exists "orders_insert" on public.orders;
create policy "orders_insert" on public.orders
  for insert to authenticated with check (true);

drop policy if exists "orders_update" on public.orders;
create policy "orders_update" on public.orders
  for update to authenticated using (true) with check (true);

drop policy if exists "orders_delete" on public.orders;
create policy "orders_delete" on public.orders
  for delete to authenticated using (true);
