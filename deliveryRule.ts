/**
 * 納品ルールおよび予定納品日計算モジュール
 * 
 * 店舗ごとの締め時刻、リードタイム、土日祝の納品可否に基づき、
 * 正確な「予定納品日」および「遅延日数」を算出します。
 */

import { supabase } from './supabase';

export interface DeliveryRule {
  store_id?: string;
  cutoff_time: string;           // 発注締め時刻 "18:30" (HH:mm)
  lead_days_before_cutoff: number; // 締め前発注の所要営業日数 (通常: 1 = 翌営業日)
  lead_days_after_cutoff: number;  // 締め後発注の所要営業日数 (通常: 2 = 翌々営業日)
  non_delivery_weekdays: number[]; // 納品なし曜日 (0:日曜, 1:月曜, ..., 6:土曜)
  holiday_no_delivery: boolean;    // 祝日は納品なしとするか
  same_day_cutoff_time?: string | null; // 当日便の締め時刻 "12:00"。この時刻までの発注は当日納品（納品日に限る）。未設定なら当日便なし
}

export const DEFAULT_DELIVERY_RULE: DeliveryRule = {
  same_day_cutoff_time: null,
  cutoff_time: '18:30',
  lead_days_before_cutoff: 1,
  lead_days_after_cutoff: 2,
  non_delivery_weekdays: [0, 6], // 日曜日、土曜日
  holiday_no_delivery: true,
};

/**
 * 春分の日・秋分の日の簡易天文計算
 */
const getVernalEquinoxDay = (year: number): number => {
  if (year <= 1979) return Math.floor(20.8357 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  if (year <= 2099) return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  return 20;
};

const getAutumnalEquinoxDay = (year: number): number => {
  if (year <= 1979) return Math.floor(23.2588 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  if (year <= 2099) return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  return 23;
};

/**
 * 日本の国民の祝日判定 (内閣府 国民の祝日に関する法律準拠 + 振替休日 + 国民の休日)
 */
export const isJapaneseHoliday = (date: Date): boolean => {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const w = date.getDay();

  // 固定祝日
  const isFixedHoliday = (
    (m === 1 && d === 1) ||  // 元日
    (m === 2 && d === 11) || // 建国記念の日
    (m === 2 && d === 23) || // 天皇誕生日 (2020年〜)
    (m === 4 && d === 29) || // 昭和の日
    (m === 5 && d === 3) ||  // 憲法記念日
    (m === 5 && d === 4) ||  // みどりの日
    (m === 5 && d === 5) ||  // こどもの日
    (m === 8 && d === 11) || // 山の日 (2016年〜)
    (m === 11 && d === 3) || // 文化の日
    (m === 11 && d === 23)   // 勤労感謝の日
  );

  if (isFixedHoliday) return true;

  // ハッピーマンデー (月曜日)
  if (w === 1) {
    const mondayCount = Math.floor((d - 1) / 7) + 1;
    if (m === 1 && mondayCount === 2) return true;  // 成人の日 (第2月曜)
    if (m === 7 && mondayCount === 3) return true;  // 海の日 (第3月曜)
    if (m === 9 && mondayCount === 3) return true;  // 敬老の日 (第3月曜)
    if (m === 10 && mondayCount === 2) return true; // スポーツの日 (第2月曜)
  }

  // 春分の日・秋分の日
  if (m === 3 && d === getVernalEquinoxDay(y)) return true;
  if (m === 9 && d === getAutumnalEquinoxDay(y)) return true;

  // 振替休日判定 (日曜が祝日の場合、その後の直近の平日が振替休日)
  // 当日が日曜日でない場合、前日以前の日曜が祝日だったか確認
  if (w !== 0) {
    let checkDate = new Date(y, m - 1, d);
    checkDate.setDate(checkDate.getDate() - 1);
    while (checkDate.getDay() >= 0) {
      if (isJapaneseHolidayBase(checkDate)) {
        if (checkDate.getDay() === 0) {
          return true; // 日曜日が祝日だったので振替休日
        }
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }
  }

  // 国民の休日判定 (前日と翌日の両方が祝日である平日。例: 5/4のみどりの日以前の旧祝日法や敬老の日と秋分の日に挟まれた平日)
  const prevDate = new Date(y, m - 1, d - 1);
  const nextDate = new Date(y, m - 1, d + 1);
  if (w !== 0 && isJapaneseHolidayBase(prevDate) && isJapaneseHolidayBase(nextDate)) {
    return true;
  }

  return false;
};

// 振替休日の再帰呼び出しを防ぐ基本祝日判定
const isJapaneseHolidayBase = (date: Date): boolean => {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const w = date.getDay();

  if (
    (m === 1 && d === 1) ||
    (m === 2 && d === 11) ||
    (m === 2 && d === 23) ||
    (m === 4 && d === 29) ||
    (m === 5 && d === 3) ||
    (m === 5 && d === 4) ||
    (m === 5 && d === 5) ||
    (m === 8 && d === 11) ||
    (m === 11 && d === 3) ||
    (m === 11 && d === 23)
  ) return true;

  if (w === 1) {
    const mondayCount = Math.floor((d - 1) / 7) + 1;
    if (m === 1 && mondayCount === 2) return true;
    if (m === 7 && mondayCount === 3) return true;
    if (m === 9 && mondayCount === 3) return true;
    if (m === 10 && mondayCount === 2) return true;
  }

  if (m === 3 && d === getVernalEquinoxDay(y)) return true;
  if (m === 9 && d === getAutumnalEquinoxDay(y)) return true;

  return false;
};

/**
 * 指定日が「納品可能営業日」かどうか判定
 */
export const isDeliveryDay = (date: Date, rule: DeliveryRule = DEFAULT_DELIVERY_RULE): boolean => {
  const dayOfWeek = date.getDay();
  // 曜日チェック (土日など納品なし曜日に含まれているか)
  if (rule.non_delivery_weekdays.includes(dayOfWeek)) {
    return false;
  }
  // 祝日チェック
  if (rule.holiday_no_delivery && isJapaneseHoliday(date)) {
    return false;
  }
  return true;
};

/**
 * 納品ルールに基づき、発注日時から「予定納品日 (YYYY-MM-DD)」を計算
 * 
 * 例: 締め時刻 18:30
 * - 木曜 18:15 発注 (締め前: 所要1営業日) -> 金曜納品
 * - 木曜 18:45 発注 (締め後: 所要2営業日) -> 金曜(1) + 土日スキップ -> 月曜納品
 * - 金曜 15:00 発注 (締め前: 所要1営業日) -> 土日スキップ -> 月曜納品
 * - 金曜 19:00 発注 (締め後: 所要2営業日) -> 土日スキップ -> 月曜(1) + 火曜(2) -> 火曜納品
 *
 * 当日便の締め時刻 12:00 を設定した場合（午後便のある卸）:
 * - 木曜 11:30 発注 -> 木曜（当日）納品
 * - 土曜 11:30 発注 (土曜は納品なし) -> 当日便は使えず、通常の締め前扱い -> 月曜納品
 */
export const calculateExpectedDeliveryDate = (
  orderDateStr: string,
  orderTimeStr?: string | null,
  rule: DeliveryRule = DEFAULT_DELIVERY_RULE
): string => {
  if (!orderDateStr) return '';

  const cleanDateStr = orderDateStr.replace(/\//g, '-');
  const [year, month, day] = cleanDateStr.split('-').map(Number);
  if (!year || !month || !day) return orderDateStr;

  // 締め時間との比較
  let requiredLeadDays = rule.lead_days_before_cutoff;
  if (orderTimeStr) {
    const timeMatch = orderTimeStr.match(/(\d{1,2}):(\d{1,2})/);
    if (timeMatch) {
      const orderMinutes = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
      const [cutoffH, cutoffM] = rule.cutoff_time.split(':').map(Number);
      const cutoffMinutes = (cutoffH || 18) * 60 + (cutoffM || 30);
      if (orderMinutes > cutoffMinutes) {
        requiredLeadDays = rule.lead_days_after_cutoff;
      }

      // 当日便：当日便の締め時刻までの発注で、発注日が納品日なら当日着
      const sameDay = (rule.same_day_cutoff_time || '').match(/(\d{1,2}):(\d{1,2})/);
      if (sameDay) {
        const sameDayMinutes = Number(sameDay[1]) * 60 + Number(sameDay[2]);
        if (orderMinutes <= sameDayMinutes && isDeliveryDay(new Date(year, month - 1, day), rule)) {
          requiredLeadDays = 0;
        }
      }
    }
  }

  // 発注日の翌日から数え始め、指定された営業日数を進める
  const cur = new Date(year, month - 1, day);
  let businessDaysCounted = 0;
  let safetyLoop = 0;

  while (businessDaysCounted < requiredLeadDays && safetyLoop < 60) {
    cur.setDate(cur.getDate() + 1);
    safetyLoop++;
    if (isDeliveryDay(cur, rule)) {
      businessDaysCounted++;
    }
  }

  // 予定納品日文字列 (YYYY-MM-DD)
  const resY = cur.getFullYear();
  const resM = String(cur.getMonth() + 1).padStart(2, '0');
  const resD = String(cur.getDate()).padStart(2, '0');
  return `${resY}-${resM}-${resD}`;
};

/**
 * 実際の納品日と予定納品日との差分日数（遅延日数）を計算
 * 
 * 予定納品日当日に届けば 0 (定刻)
 * 1日遅れれば +1, 2日遅れれば +2
 */
export const calculateDelayDays = (
  actualDateStr: string,
  expectedDateStr: string,
  rule: DeliveryRule = DEFAULT_DELIVERY_RULE
): number => {
  if (!actualDateStr || !expectedDateStr) return 0;
  const a = new Date(actualDateStr.replace(/\//g, '-')).getTime();
  const e = new Date(expectedDateStr.replace(/\//g, '-')).getTime();
  return Math.round((a - e) / (1000 * 60 * 60 * 24));
};

/**
 * 店舗設定の読み書き用ヘルパー (localStorage + キャッシュ)
 */
export const getDeliveryRule = (storeId?: string): DeliveryRule => {
  if (!storeId) return DEFAULT_DELIVERY_RULE;
  try {
    const saved = localStorage.getItem(`pharma_delivery_rule_${storeId}`);
    if (saved) {
      const parsed = JSON.parse(saved);
      return { ...DEFAULT_DELIVERY_RULE, ...parsed };
    }
  } catch (err) {
    console.warn('Error reading delivery rule from localStorage:', err);
  }
  return DEFAULT_DELIVERY_RULE;
};

export const saveDeliveryRule = (storeId: string, rule: DeliveryRule): void => {
  if (!storeId) return;
  try {
    localStorage.setItem(`pharma_delivery_rule_${storeId}`, JSON.stringify(rule));
  } catch (err) {
    console.warn('Error saving delivery rule to localStorage:', err);
  }
};

/* =====================================================================
 * 卸ごとの納品ルール（データベース delivery_rules テーブルで全端末共有）
 *
 *  - 店舗の「基本ルール」 … supplier_key = ''（空文字）の行
 *  - 卸ごとの「個別ルール」 … supplier_key = 正規化した卸名 の行
 *  - 個別ルールがない卸の発注は、基本ルールで予定納品日を計算する
 * ===================================================================== */

export interface SupplierDeliveryRule extends DeliveryRule {
  supplier_label: string; // 画面表示用の卸名（取込データ上の表記）
}

export interface DeliveryRuleSet {
  base: DeliveryRule;
  bySupplier: Record<string, SupplierDeliveryRule>; // キー = normalizeSupplier(卸名)
}

export const DELIVERY_RULES_TABLE = 'delivery_rules';

// 卸名の表記ゆれをそろえる（全角半角統一・「株式会社」等の除去・空白除去）
export const normalizeSupplier = (s: string | null | undefined): string =>
  (s || '')
    .normalize('NFKC')
    .replace(/株式会社|\(株\)|㈱|有限会社|\(有\)/g, '')
    .replace(/[\s　]/g, '')
    .trim();

// 発注の卸名から、使うべき納品ルールを選ぶ（個別ルールがなければ基本ルール）
export const resolveDeliveryRule = (set: DeliveryRuleSet, supplier: string | null | undefined): DeliveryRule => {
  const key = normalizeSupplier(supplier);
  return (key && set.bySupplier[key]) || set.base;
};

const pickRule = (row: any): DeliveryRule => ({
  store_id: row.store_id,
  cutoff_time: row.cutoff_time || DEFAULT_DELIVERY_RULE.cutoff_time,
  lead_days_before_cutoff: Number(row.lead_days_before_cutoff ?? DEFAULT_DELIVERY_RULE.lead_days_before_cutoff),
  lead_days_after_cutoff: Number(row.lead_days_after_cutoff ?? DEFAULT_DELIVERY_RULE.lead_days_after_cutoff),
  non_delivery_weekdays: Array.isArray(row.non_delivery_weekdays) ? row.non_delivery_weekdays.map(Number) : DEFAULT_DELIVERY_RULE.non_delivery_weekdays,
  holiday_no_delivery: row.holiday_no_delivery ?? DEFAULT_DELIVERY_RULE.holiday_no_delivery,
  same_day_cutoff_time: row.same_day_cutoff_time || null,
});

/**
 * 店舗の納品ルール一式をデータベースから読み込む。
 * テーブル未作成などで読めない場合は、従来どおりブラウザ保存の店舗ルールを基本ルールとして使う（画面を壊さない）。
 * 戻り値の tableReady が false のときは、保存先テーブルがまだ用意されていない。
 */
export const loadDeliveryRules = async (storeId?: string): Promise<{ set: DeliveryRuleSet; tableReady: boolean }> => {
  const fallback: DeliveryRuleSet = { base: getDeliveryRule(storeId), bySupplier: {} };
  if (!storeId) return { set: fallback, tableReady: true };
  try {
    const { data, error } = await supabase.from(DELIVERY_RULES_TABLE).select('*').eq('store_id', storeId);
    if (error) throw error;
    const set: DeliveryRuleSet = { base: fallback.base, bySupplier: {} };
    for (const row of data || []) {
      if (!row.supplier_key) {
        set.base = pickRule(row);
      } else {
        set.bySupplier[row.supplier_key] = { ...pickRule(row), supplier_label: row.supplier_label || row.supplier_key };
      }
    }
    return { set, tableReady: true };
  } catch (err) {
    console.warn('納品ルールテーブルを読み込めませんでした（未作成の可能性）。ブラウザ保存の店舗ルールを使用します:', err);
    return { set: fallback, tableReady: false };
  }
};

/**
 * 店舗の納品ルール一式をデータベースへ保存する（基本ルール＋卸ごとの個別ルール）。
 * 画面で削除された卸の個別ルールは、データベースからも削除する。
 */
export const saveDeliveryRules = async (storeId: string, set: DeliveryRuleSet): Promise<void> => {
  const toRow = (supplier_key: string, supplier_label: string | null, r: DeliveryRule) => ({
    store_id: storeId,
    supplier_key,
    supplier_label,
    cutoff_time: r.cutoff_time,
    lead_days_before_cutoff: r.lead_days_before_cutoff,
    lead_days_after_cutoff: r.lead_days_after_cutoff,
    non_delivery_weekdays: r.non_delivery_weekdays,
    holiday_no_delivery: r.holiday_no_delivery,
    same_day_cutoff_time: r.same_day_cutoff_time || null,
    updated_at: new Date().toISOString(),
  });

  const rows = [
    toRow('', null, set.base),
    ...Object.entries(set.bySupplier).map(([key, r]) => toRow(key, r.supplier_label, r)),
  ];

  const { error: upErr } = await supabase
    .from(DELIVERY_RULES_TABLE)
    .upsert(rows, { onConflict: 'store_id,supplier_key' });
  if (upErr) throw upErr;

  // 画面で外した卸の個別ルールを削除
  const { data: existing, error: selErr } = await supabase
    .from(DELIVERY_RULES_TABLE)
    .select('supplier_key')
    .eq('store_id', storeId);
  if (selErr) throw selErr;
  const keep = new Set(['', ...Object.keys(set.bySupplier)]);
  const removeKeys = (existing || []).map((r: any) => r.supplier_key).filter((k: string) => !keep.has(k));
  if (removeKeys.length > 0) {
    const { error: delErr } = await supabase
      .from(DELIVERY_RULES_TABLE)
      .delete()
      .eq('store_id', storeId)
      .in('supplier_key', removeKeys);
    if (delErr) throw delErr;
  }

  // 基本ルールはブラウザにも控えておく（テーブルが読めない時の予備）
  saveDeliveryRule(storeId, set.base);
};
