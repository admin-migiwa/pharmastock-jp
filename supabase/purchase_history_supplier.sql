-- 入庫履歴に「仕入先」列を追加する（任意・推奨）
-- 用途：他店からの分譲を、卸からの納品として発注に割り当てないようにする。発注先と違う卸の入庫も区別する。
-- 未実行でも取り込み・照合は動作する（その場合は仕入先を区別しない）。
alter table public.purchase_history add column if not exists supplier text;

-- 追加した列をAPI（PostgREST）にすぐ認識させる
notify pgrst, 'reload schema';
