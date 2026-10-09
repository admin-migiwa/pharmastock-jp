-- 除外対象発注品目マスタテーブル
-- Supabase の SQL Editor で実行してください。

create table if not exists public.ignored_order_items (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null,                     -- 店舗ID
  jan_code    text,                              -- JANコード (13桁)
  name        text not null,                     -- 薬品名・商品名
  name_key    text not null,                     -- 照合用正規化品名
  reason      text default '一般品・自費品',      -- 除外理由
  created_at  timestamptz not null default now()
);

create index if not exists ignored_order_items_store_id_idx on public.ignored_order_items (store_id);
create index if not exists ignored_order_items_jan_code_idx on public.ignored_order_items (jan_code);

alter table public.ignored_order_items enable row level security;

drop policy if exists "ignored_order_items_select" on public.ignored_order_items;
create policy "ignored_order_items_select" on public.ignored_order_items
  for select to authenticated using (true);

drop policy if exists "ignored_order_items_insert" on public.ignored_order_items;
create policy "ignored_order_items_insert" on public.ignored_order_items
  for insert to authenticated with check (true);

drop policy if exists "ignored_order_items_delete" on public.ignored_order_items;
create policy "ignored_order_items_delete" on public.ignored_order_items
  for delete to authenticated using (true);
