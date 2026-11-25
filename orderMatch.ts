import { supabase } from './supabase';
import { Order, OrderStatus } from './types';
import { normalizeName } from './shipmentMatch';

// JANコード/GS1コードの正規化（14桁GS1の先頭1桁を除去して13桁JANにする等）
export const normalizeJanCode = (code: string | null | undefined): string => {
  if (!code) return '';
  const cleaned = code.toString().replace(/[-_ \u3000]/g, '').trim();
  if (cleaned.length === 14 && cleaned.startsWith('1')) {
    return cleaned.slice(1);
  }
  return cleaned;
};

// 照合専用キー。JAN13とGS1 14桁は共通の12桁で比較する（末尾のチェックディジットは両者で異なるため除く）。
// 保存値（orders.jan_code は再取込時の重複判定キー）を変えないよう、normalizeJanCode とは分けている。
const toJanMatchKey = (code: string | null | undefined): string => {
  const cleaned = (code || '').toString().replace(/[-_ \u3000]/g, '').trim();
  if (/^\d{14}$/.test(cleaned)) return cleaned.slice(1, 13);
  if (/^\d{13}$/.test(cleaned)) return cleaned.slice(0, 12);
  // 厚生省コード等、JAN/GS1以外はそのまま比較（12桁数字でもJANの12桁と混同しないよう区別）
  return cleaned ? 'raw:' + cleaned : '';
};

// 発注時刻の比較用表記。「9:05」「09:05:00」のような表記差を吸収する（保存値は変えない）
export const normalizeOrderTime = (time: string | null | undefined): string => {
  const t = (time || '').trim();
  const m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}:${m[3] || '00'}` : t;
};

const PAGE_SIZE = 1000;
const MAX_CONSECUTIVE_FAILURES = 5;

// Supabaseは1回の取得が既定で最大1000件のため、空になるまで続きを取得する。
// 呼び出し側は、ページ間で順序が変わらないよう一意な列(id)まで並び順に含めること。
export const fetchAllPages = async <T,>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>
): Promise<T[]> => {
  const all: T[] = [];
  while (true) {
    const { data, error } = await fetchPage(all.length, all.length + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) return all;
    all.push(...data);
  }
};

const UNIT_ALIAS: Record<string, string> = { 'カプセル': 'C', 'CAP': 'C', 'キッ': 'キット', 'グラム': 'G', 'CC': 'ML' };
const normUnit = (u: string): string => {
  const k = u.normalize('NFKC').replace(/\s/g, '').toUpperCase();
  return UNIT_ALIAS[k] || k;
};

// 発注CSVの規格容量から、1箱の総量を単位ごとに求める。
// 例「5mg/錠 PTP 10錠×10」→ 100錠、「0.12%1g 5g×10本」→ 50g または 10本
export const parsePackTotals = (spec: string | null | undefined): { unit: string; total: number }[] => {
  const s = (spec || '').normalize('NFKC').replace(/,/g, '').replace(/\([^()]*\)/g, '').trim();
  const num = '(\\d+(?:\\.\\d+)?)';
  const unit = '([^\\d\\s×xX*/.%]+)';
  const m = s.match(new RegExp(`${num}\\s*${unit}\\s*[×xX*]\\s*${num}\\s*${unit}?$`));
  if (m) {
    const totals = [{ unit: normUnit(m[2]), total: Number(m[1]) * Number(m[3]) }];
    const outer = m[4] ? normUnit(m[4]) : '';
    if (outer && outer !== totals[0].unit) totals.push({ unit: outer, total: Number(m[3]) });
    return totals.filter(t => t.total > 0);
  }
  // 「バラ 1000錠」のように掛け算のない規格
  const single = s.match(new RegExp(`(?:^|\\s)${num}\\s*${unit}$`));
  return single && Number(single[1]) > 0 ? [{ unit: normUnit(single[2]), total: Number(single[1]) }] : [];
};

// 入庫の薬品名の末尾「(PTP1錠)」「(ﾁｭｰﾌﾞ5ｇ)」から数量の単位を取り出し、包装表記を除いた品名も返す
const splitPackName = (name: string): { base: string; unit: string } => {
  const n = (name || '').normalize('NFKC').trim();
  const m = n.match(/\([^()]*\d\s*([^\d()\s.,]+)\)$/);
  return m ? { base: n.slice(0, m.index), unit: normUnit(m[1]) } : { base: n, unit: '' };
};

// 仕入先が卸ではなく他の薬局（分譲・店舗間移動）か。取込側 import-inventory の isTransferSupplier と同じ条件
const isTransferSupplier = (s: string | null | undefined): boolean =>
  /分譲|譲受|薬局|他店|移管|譲渡/.test((s || '').normalize('NFKC'));

export interface ParsedOrderRow {
  order_date: string;
  order_time: string | null;
  delivery_date: string;
  jan_code: string;
  name: string;
  name_key: string;
  spec: string | null;
  maker: string | null;
  supplier: string | null;
  order_qty: number;
}

const splitCsvLine = (line: string): string[] => {
  const result: string[] = [];
  let curVal = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ',' && !inQuotes) { result.push(curVal.trim()); curVal = ''; }
    else curVal += char;
  }
  result.push(curVal.trim());
  return result;
};

const toStr = (v: any): string => (v || '').toString().replace(/^"|"$/g, '').trim();

const toDateStr = (v: string): string => {
  const s = toStr(v).replace(/[\/\.]/g, '-');
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return s;
};

/**
 * 発注CSV (hachu_XXXXX.csv) のパース処理
 */
export const parseOrderCsv = (csvText: string): ParsedOrderRow[] => {
  const cleanText = csvText.replace(/\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = cleanText.split('\n').filter(l => l.trim() !== '');
  if (lines.length < 2) throw new Error('発注CSVデータが空かヘッダーがありません');

  const headers = splitCsvLine(lines[0]).map(toStr);

  const getColIdx = (exactNames: string[], keywords: string[]) => {
    let idx = headers.findIndex(h => exactNames.includes(h.trim()));
    if (idx !== -1) return idx;
    return headers.findIndex(h => 
      keywords.some(k => h.includes(k)) && 
      !/最終|累積|単位|薬価|金額/.test(h)
    );
  };

  const idx = {
    orderDate: getColIdx(['発注日時(日付)', '発注日', '日付'], ['発注日', '日付']),
    orderTime: getColIdx(['発注日時(時間)', '時間', '時刻'], ['時間', '時刻']),
    name: getColIdx(['品名', '商品名', '薬品名'], ['品名', '商品名', '薬品名']),
    spec: getColIdx(['規格容量', '規格'], ['規格']),
    maker: getColIdx(['メーカー名', 'メーカー', '製造会社'], ['メーカー', '製造']),
    code: getColIdx(['商品コード', 'JANコード', 'コード'], ['商品コード', 'JAN', 'コード']),
    qty: getColIdx(
      ['発注数量', '発注数', '注文数量', '注文数', '発注箱数', '数量', '箱数'],
      ['発注数', '注文数', '箱数', '数量']
    ),
    supplier: getColIdx(['発注先卸名', '卸名', '発注先'], ['卸名', '発注先', '卸']),
    deliveryDate: getColIdx(['納品指定日', '指定日', '納品日'], ['指定日', '納品日']),
  };

  if (idx.name === -1 || idx.code === -1 || idx.qty === -1) {
    throw new Error('必須項目（品名・商品コード・発注数量）が見つかりません。ファイル形式を確認してください。');
  }

  const rows: ParsedOrderRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length <= Math.max(idx.name, idx.code, idx.qty)) continue;

    const rawCode = toStr(cols[idx.code]);
    const janCode = normalizeJanCode(rawCode);
    const name = toStr(cols[idx.name]);
    const qty = Number(toStr(cols[idx.qty])) || 0;
    if (!name || !janCode || qty <= 0) continue;

    const orderDate = idx.orderDate !== -1 ? toDateStr(cols[idx.orderDate]) : new Date().toISOString().slice(0, 10);
    const deliveryDate = idx.deliveryDate !== -1 ? toDateStr(cols[idx.deliveryDate]) : orderDate;

    rows.push({
      order_date: orderDate,
      order_time: idx.orderTime !== -1 ? toStr(cols[idx.orderTime]) || null : null,
      delivery_date: deliveryDate,
      jan_code: janCode,
      name,
      name_key: normalizeName(name),
      spec: idx.spec !== -1 ? toStr(cols[idx.spec]) || null : null,
      maker: idx.maker !== -1 ? toStr(cols[idx.maker]) || null : null,
      supplier: idx.supplier !== -1 ? toStr(cols[idx.supplier]) || null : null,
      order_qty: qty,
    });
  }

  return rows;
};

import { 
  DeliveryRule, 
  DEFAULT_DELIVERY_RULE, 
  calculateExpectedDeliveryDate, 
  calculateDelayDays,
  DeliveryRuleSet,
  loadDeliveryRules,
  resolveDeliveryRule,
  normalizeSupplier
} from './deliveryRule';

/**
 * ２つの日付文字列 (YYYY-MM-DD) の差分日数 (dateA - dateB)
 */
export const diffDays = (dateAStr: string, dateBStr: string): number => {
  const a = new Date(dateAStr).getTime();
  const b = new Date(dateBStr).getTime();
  return Math.round((a - b) / (1000 * 60 * 60 * 24));
};

/**
 * 納品遅れ・日数ズレ（ラグ）の視覚化用バッジ情報
 */
export interface DelayBadgeInfo {
  label: string;
  level: 'on_time' | 'slight_delay' | 'severe_delay' | 'early' | 'pending_overdue' | 'pending';
  days: number;
  expectedDate?: string;
}

export const getDelayBadge = (order: Order, rule: DeliveryRule = DEFAULT_DELIVERY_RULE): DelayBadgeInfo => {
  const todayStr = new Date().toISOString().slice(0, 10);

  // 店舗の納品ルールから算出した「真の予定納品日」
  const expectedDate = calculateExpectedDeliveryDate(order.order_date, order.order_time, rule) || order.delivery_date;

  // 納品済（完納・分納）の場合
  if (order.actual_delivery_date) {
    // 予定納品日との差分で遅延を判定 (±0日は定刻着荷)
    const days = calculateDelayDays(order.actual_delivery_date, expectedDate, rule);
    if (days === 0) return { label: '定刻 (±0日)', level: 'on_time', days, expectedDate };
    if (days > 0 && days <= 2) return { label: `+${days}日遅れ`, level: 'slight_delay', days, expectedDate };
    if (days > 2) return { label: `+${days}日遅れ (出荷調整疑い)`, level: 'severe_delay', days, expectedDate };
    return { label: `${days}日 (早納)`, level: 'early', days, expectedDate };
  }

  // 未完了の場合 (今日と予定納品日との差分)
  const daysOver = calculateDelayDays(todayStr, expectedDate, rule);
  if (daysOver > 0) {
    return { label: `${daysOver}日経過 未納`, level: 'pending_overdue', days: daysOver, expectedDate };
  }
  return { label: '入荷待ち', level: 'pending', days: 0, expectedDate };
};

/**
 * 発注と入庫履歴（purchase_history）の消し込みロジック
 * ※店舗ごとの配送ルール（締め時間・土日祝なし）に基づき予定日を算出し照合します。
 */
export const reconcileOrders = async (storeId: string, marginDays = 7, customRules?: DeliveryRuleSet) => {
  // 卸ごとの納品ルール一式（未指定ならデータベースから読み込む）
  const ruleSet = customRules || (await loadDeliveryRules(storeId)).set;
  const allOrders = await fetchAllPages<Order>((from, to) => supabase
    .from('orders')
    .select('*')
    .eq('store_id', storeId)
    .neq('status', 'cancelled')
    .order('order_date', { ascending: true })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to));

  if (allOrders.length === 0) return { updatedCount: 0 };

  // 同じ日の発注は時刻の早い順に入庫を割り当てる（同時刻は取得時の登録順のまま）
  allOrders.sort((a, b) =>
    a.order_date.localeCompare(b.order_date) ||
    normalizeOrderTime(a.order_time).localeCompare(normalizeOrderTime(b.order_time)));

  // 最古の発注日より前の入庫は照合対象にならないため取得しない（発注は日付の昇順）
  const purList = await fetchAllPages<any>((from, to) => supabase
    .from('purchase_history')
    .select('*')
    .eq('store_id', storeId)
    .gte('purchase_date', allOrders[0].order_date)
    .order('purchase_date', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to));

  // 同じ納品が旧取込分（JANなし）と二重に残っている場合は、JANありの行だけを使う
  const isJan = (code: string) => /^\d{13,14}$/.test(code || '');
  const deliveryKey = (p: any) => `${p.purchase_date}|${normalizeName(p.name)}|${p.lot_number}`;
  const withJan = new Set(purList.filter(p => isJan(p.yakka_code)).map(deliveryKey));

  // 入庫履歴をプールに変換（他店分譲伝票を除外し、純粋な卸からの入庫のみに絞り込む）
  const purchasePool = purList
    // 返品だけの行は除く。同日に入庫と返品があり総量0の行は「届いた事実」として残す
    .filter(p => (Number(p.quantity) >= 0 || Number(p.box_qty) > 0) && (isJan(p.yakka_code) || !withJan.has(deliveryKey(p))))
    .map(p => {
      const pack = splitPackName(p.name);
      const supp = (p as any).supplier || (p as any).wholesaler || (p as any).source || (p as any).trade_type || null;
      const isTransfer = isTransferSupplier(supp);

      return {
        id: p.id,
        purchase_date: p.purchase_date,
        jan_key: toJanMatchKey(p.yakka_code || (p as any).jan_code),
        name_key: normalizeName(pack.base),
        unit: pack.unit,
        quantity: Number(p.quantity),
        box_qty: Number(p.box_qty) > 0 ? Number(p.box_qty) : null,
        supplier: supp,
        is_transfer: isTransfer,
        left: 1, // この入庫のうち未割り当ての割合（1 = 全量）
      };
    })
    // 他店分譲（分譲受入）のデータは卸照合のプールから100%排除
    .filter(p => !p.is_transfer);

  const EPS = 0.0001;

  // この入庫が、その発注の包装で何箱分にあたるか
  const boxesFor = (item: typeof purchasePool[number], packTotals: { unit: string; total: number }[], sameJan: boolean): number => {
    // 同じJAN（=同じ包装）なら、入庫ファイルの箱数をそのまま使う
    if (sameJan && item.box_qty !== null) return item.box_qty;
    // 包装違い、または箱数が未登録の入庫は、総量 ÷ 発注した包装の1箱の総量
    const pack = item.unit ? packTotals.find(t => t.unit === item.unit) : packTotals[0];
    if (pack && item.quantity > 0) return item.quantity / pack.total;
    // 規格から計算できない場合：同じJANなら最低1箱は届いている。包装違いは判断できないため使わない
    return sameJan ? 1 : 0;
  };

  const todayStr = new Date().toISOString().slice(0, 10);
  const updates: Partial<Order>[] = [];

  const targets = allOrders.map(ord => {
    // 発注先の卸に設定された納品ルール（なければ店舗の基本ルール）
    const rule = resolveDeliveryRule(ruleSet, ord.supplier);
    // そのルールに基づいた予定納品日を計算 (土日祝や発注締め時刻を考慮)
    const expectedDate = calculateExpectedDeliveryDate(ord.order_date, ord.order_time, rule) || ord.delivery_date;

    // 期間フィルタ: 発注日 <= 入庫日 <= 予定納品日 + marginDays
    const maxDate = new Date(expectedDate);
    maxDate.setDate(maxDate.getDate() + marginDays);
    const maxDateStr = maxDate.toISOString().slice(0, 10);

    return {
      ord, rule, expectedDate, maxDateStr,
      janKey: toJanMatchKey(ord.jan_code),
      packTotals: parsePackTotals(ord.spec),
      needed: ord.order_qty,
      firstDelivDate: null as string | null,
    };
  });

  // 先に全発注をJANで照合し、残った入庫だけを品名（包装違い）で照合する。
  // 包装違いの入庫を先に使って、本来の発注が未納品になるのを防ぐため。
  for (const byJan of [true, false]) for (const target of targets) {
    const { ord, maxDateStr, janKey: orderJanKey } = target;

    // 卸入庫データの消し込み検索
    for (const poolItem of purchasePool) {
      if (target.needed <= EPS) break;
      if (poolItem.left <= EPS) continue;
      if (poolItem.purchase_date < ord.order_date || poolItem.purchase_date > maxDateStr) continue;

      const janMatch = orderJanKey && poolItem.jan_key && orderJanKey === poolItem.jan_key;
      const nameMatch = ord.name_key && poolItem.name_key && ord.name_key === poolItem.name_key;

      if (byJan ? !janMatch : janMatch || !nameMatch) continue;

      // 卸指定がある場合は、異なる卸からの入庫データは除外
      if (ord.supplier && poolItem.supplier) {
        const s1 = normalizeSupplier(ord.supplier).replace(/営業所|支店/g, '');
        const s2 = normalizeSupplier(poolItem.supplier).replace(/営業所|支店/g, '');
        const supplierMatch = s1.includes(s2) || s2.includes(s1);
        if (!supplierMatch) continue;
      }

      const boxes = boxesFor(poolItem, target.packTotals, byJan);
      const take = Math.min(target.needed, boxes * poolItem.left);
      if (take <= EPS) continue;
      target.needed -= take;
      poolItem.left -= take / boxes;

      if (!target.firstDelivDate || poolItem.purchase_date < target.firstDelivDate) {
        target.firstDelivDate = poolItem.purchase_date;
      }
    }
  }

  for (const { ord, rule, expectedDate, needed, firstDelivDate } of targets) {
    // 完納かどうかは端数込みで判定し、画面に出す納品数は揃った箱数（切り捨て）とする
    const isFull = needed <= EPS;
    const allocatedBoxQty = isFull ? ord.order_qty : Math.floor(ord.order_qty - needed + EPS);
    let newStatus: OrderStatus = ord.status;
    let delayDays: number | null = ord.delay_days ?? null;

    if (isFull) {
      newStatus = 'fulfilled';
      if (firstDelivDate) delayDays = calculateDelayDays(firstDelivDate, expectedDate, rule);
    } else if (firstDelivDate) {
      newStatus = 'partial';
      if (firstDelivDate) delayDays = calculateDelayDays(firstDelivDate, expectedDate, rule);
    } else {
      if (todayStr > expectedDate) {
        newStatus = 'delayed';
      } else {
        newStatus = 'pending';
      }
    }

    if (
      newStatus !== ord.status ||
      allocatedBoxQty !== ord.delivered_qty ||
      firstDelivDate !== ord.actual_delivery_date ||
      delayDays !== ord.delay_days
    ) {
      updates.push({
        id: ord.id,
        delivered_qty: allocatedBoxQty,
        actual_delivery_date: firstDelivDate,
        delay_days: delayDays,
        status: newStatus,
        updated_at: new Date().toISOString(),
      });
    }
  }

  // 1件ずつ更新。失敗しても残りは続け、最後にまとめてエラーにする（再照合すれば残りが更新される）
  let updatedCount = 0;
  let failedCount = 0;
  let consecutiveFailures = 0;
  let firstError = '';
  for (const item of updates) {
    // 権限不足や削除済みで対象が0件でもエラーにならないため、更新できた行を受け取って確認する
    const { data, error } = await supabase.from('orders').update(item).eq('id', item.id!).select('id');
    if (!error && data && data.length > 0) {
      updatedCount++;
      consecutiveFailures = 0;
      continue;
    }
    failedCount++;
    consecutiveFailures++;
    if (!firstError) firstError = error?.message || '更新対象の発注が見つからないか、更新権限がありません';
    console.error('Order update failed:', item.id, error);
    // 通信断などで全件失敗し続ける場合は打ち切る
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
  }

  if (failedCount > 0) {
    const skipped = updates.length - updatedCount - failedCount;
    throw new Error(
      `発注の更新に失敗しました（成功 ${updatedCount} 件 / 失敗 ${failedCount} 件${skipped > 0 ? ` / 未処理 ${skipped} 件` : ''}）: ${firstError}`
    );
  }

  return { updatedCount };
};
