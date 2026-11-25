-- 入庫履歴に「包装の照合キー」列を追加する（任意・推奨）
-- 用途：南森町形式では同じ商品名でも包装違い（ＰＴＰ/100、バラ/1,000 など）が別の在庫行になるため、
--       どの包装の入庫かを区別して期限・ロットを割り当てる。
-- 未実行でも取り込みは動作する（その場合は商品名のみで割り当て）。
alter table public.purchase_history add column if not exists pack_key text;

-- 追加した列をAPI（PostgREST）にすぐ認識させる
notify pgrst, 'reload schema';
