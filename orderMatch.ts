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
}

export const getDelayBadge = (order: Order): DelayBadgeInfo => {
  const todayStr = new Date().toISOString().slice(0, 10);

  // 納品済（完納・分納）の場合
  if (order.actual_delivery_date) {
    const days = order.delay_days ?? diffDays(order.actual_delivery_date, order.delivery_date);
    if (days === 0) return { label: '定刻 (±0日)', level: 'on_time', days };
    if (days > 0 && days <= 2) return { label: `+${days}日遅れ`, level: 'slight_delay', days };
    if (days > 2) return { label: `+${days}日遅れ (調整疑い)`, level: 'severe_delay', days };
    return { label: `${days}日 (早納)`, level: 'early', days };
  }

  // 未完了の場合
  const daysOver = diffDays(todayStr, order.delivery_date);
  if (daysOver > 0) {
    return { label: `${daysOver}日経過 未納`, level: 'pending_overdue', days: daysOver };
  }
  return { label: '入荷待ち', level: 'pending', days: 0 };
};

/**
 * 発注と入庫履歴（purchase_history）の消し込みロジック (FIFO順アロケーション)
 */
export const reconcileOrders = async (storeId: string, marginDays = 7) => {
  const { data: allOrders, error: orderErr } = await supabase
    .from('orders')
    .select('*')
    .eq('store_id', storeId)
    .neq('status', 'cancelled')
    .order('order_date', { ascending: true })
    .order('created_at', { ascending: true });

  if (orderErr) throw orderErr;
  if (!allOrders || allOrders.length === 0) return { updatedCount: 0 };

  const { data: purchases, error: purErr } = await supabase
    .from('purchase_history')
    .select('*')
    .eq('store_id', storeId)
    .order('purchase_date', { ascending: true });

  if (purErr) throw purErr;
  const purList = purchases || [];

  // 入庫履歴をプールに変換（箱数単位への換算 + 残数トラッキング）
  const purchasePool = purList.map(p => {
    const q = Number(p.quantity) || 1;
    let boxes = 1;
    if (q <= 50) {
      boxes = q;
    } else if (q % 100 === 0) {
      boxes = q / 100;
    } else if (q % 42 === 0) {
      boxes = q / 42;
    } else if (q % 84 === 0) {
      boxes = q / 84;
    } else {
      boxes = Math.max(1, Math.round(q / 100));
    }

    return {
      id: p.id,
      purchase_date: p.purchase_date,
      jan_code: normalizeJanCode(p.yakka_code || (p as any).jan_code),
      name_key: normalizeName(p.name),
      available_boxes: boxes,
    };
  });

  const todayStr = new Date().toISOString().slice(0, 10);
  const updates: Partial<Order>[] = [];

  for (const ord of allOrders as Order[]) {
    // 期間フィルタ: 発注日 <= 入庫日 <= 指定日 + marginDays
    const maxDate = new Date(ord.delivery_date);
    maxDate.setDate(maxDate.getDate() + marginDays);
    const maxDateStr = maxDate.toISOString().slice(0, 10);

    let needed = ord.order_qty;
    let allocatedBoxQty = 0;
    let firstDelivDate: string | null = null;

    for (const poolItem of purchasePool) {
      if (needed <= 0) break;
      if (poolItem.available_boxes <= 0) continue;
      if (poolItem.purchase_date < ord.order_date || poolItem.purchase_date > maxDateStr) continue;

      // JAN一致または正規化名称一致
      const janMatch = ord.jan_code && poolItem.jan_code && ord.jan_code === poolItem.jan_code;
      const nameMatch = ord.name_key && poolItem.name_key && ord.name_key === poolItem.name_key;

      if (janMatch || nameMatch) {
        const take = Math.min(needed, poolItem.available_boxes);
        allocatedBoxQty += take;
        needed -= take;
        poolItem.available_boxes -= take;

        if (!firstDelivDate && take > 0) {
          firstDelivDate = poolItem.purchase_date;
        }
      }
    }

    let newStatus: OrderStatus = ord.status;
    let delayDays: number | null = ord.delay_days ?? null;

    if (allocatedBoxQty >= ord.order_qty) {
      newStatus = 'fulfilled';
      if (firstDelivDate) delayDays = diffDays(firstDelivDate, ord.delivery_date);
    } else if (allocatedBoxQty > 0) {
      newStatus = 'partial';
      if (firstDelivDate) delayDays = diffDays(firstDelivDate, ord.delivery_date);
    } else {
      if (todayStr > ord.delivery_date) {
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

  // バッチ更新
  if (updates.length > 0) {
    for (const item of updates) {
      await supabase.from('orders').update(item).eq('id', item.id);
    }
  }

  return { updatedCount: updates.length };
};
