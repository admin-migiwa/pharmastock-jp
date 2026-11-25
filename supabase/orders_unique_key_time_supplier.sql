-- 同じ日・同じ薬・同じ数量でも、発注時刻または卸が違えば別の発注として登録できるようにする。
-- アプリの新版を公開する「前」に、Supabase の SQL Editor で実行してください。
-- 既存データは変更・削除しません（重複を禁止する条件を緩めるだけ）。
begin;

create unique index if not exists orders_unique_key_v2_idx on public.orders
  (store_id, order_date, jan_code, order_qty, coalesce(order_time, ''), coalesce(supplier, ''));

drop index if exists public.orders_unique_key_idx;

commit;
