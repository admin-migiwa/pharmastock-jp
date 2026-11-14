-- 納品ルールテーブル（店舗の基本ルール＋卸ごとの個別ルール）
-- Supabase の SQL Editor で実行してください。
--
--   supplier_key = ''（空文字） … 店舗の基本ルール
--   supplier_key = 卸名（表記をそろえたもの） … その卸だけの個別ルール

create table if not exists public.delivery_rules (
  id                       uuid primary key default gen_random_uuid(),
  store_id                 uuid not null,                          -- 店舗ID
  supplier_key             text not null default '',               -- 卸名（正規化）。空文字は店舗の基本ルール
  supplier_label           text,                                   -- 画面表示用の卸名
  cutoff_time              text not null default '18:30',          -- 発注締め時刻 (HH:mm)
  lead_days_before_cutoff  integer not null default 1,             -- 締め前発注の所要営業日数
  lead_days_after_cutoff   integer not null default 2,             -- 締め後発注の所要営業日数
  non_delivery_weekdays    integer[] not null default '{0,6}',     -- 納品なし曜日 (0:日〜6:土)
  holiday_no_delivery      boolean not null default true,          -- 祝日は納品なし
  same_day_cutoff_time     text,                                   -- 当日便の締め時刻 (HH:mm)。空なら当日便なし
  updated_at               timestamptz not null default now(),
  unique (store_id, supplier_key)
);

-- すでに表を作成済みの場合に備えて、当日便の列を追加（あれば何もしない）
alter table public.delivery_rules add column if not exists same_day_cutoff_time text;

create index if not exists delivery_rules_store_id_idx on public.delivery_rules (store_id);

alter table public.delivery_rules enable row level security;

-- ログイン済みの全ユーザーが参照・操作可能（他のテーブルと同じ方針）
drop policy if exists "delivery_rules_select" on public.delivery_rules;
create policy "delivery_rules_select" on public.delivery_rules
  for select to authenticated using (true);

drop policy if exists "delivery_rules_insert" on public.delivery_rules;
create policy "delivery_rules_insert" on public.delivery_rules
  for insert to authenticated with check (true);

drop policy if exists "delivery_rules_update" on public.delivery_rules;
create policy "delivery_rules_update" on public.delivery_rules
  for update to authenticated using (true) with check (true);

drop policy if exists "delivery_rules_delete" on public.delivery_rules;
create policy "delivery_rules_delete" on public.delivery_rules
  for delete to authenticated using (true);
