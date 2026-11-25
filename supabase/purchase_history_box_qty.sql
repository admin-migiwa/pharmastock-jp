-- 入庫履歴に「箱数」列を追加する（任意・推奨）
-- 用途：発注（箱数）と入庫を、推測ではなく入庫ファイルの箱数（返品を差し引かない納品箱数）で照合する。
-- 未実行でも取り込み・照合は動作する（その場合は「総量 ÷ 発注CSVの規格容量」で箱数を計算）。
alter table public.purchase_history add column if not exists box_qty numeric;

-- 追加した列をAPI（PostgREST）にすぐ認識させる
notify pgrst, 'reload schema';
