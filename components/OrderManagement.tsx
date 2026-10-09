import React, { useState, useEffect, useMemo } from 'react';
import { 
  Upload, 
  FileSpreadsheet, 
  Search, 
  Filter, 
  RefreshCw, 
  CheckCircle2, 
  AlertTriangle, 
  Clock, 
  AlertCircle, 
  ChevronLeft, 
  ChevronRight, 
  Trash2, 
  Info,
  Calendar,
  Building2,
  PackageCheck,
  Check,
  ShieldAlert,
  EyeOff,
  PlusCircle,
  ShieldCheck,
  ListFilter,
  CheckSquare,
  Square,
  Download,
  Printer
} from 'lucide-react';
import { Store, Order, OrderStatus, IgnoredOrderItem, ShipmentLookup } from '../types';
import { supabase } from '../supabase';
import { parseOrderCsv, reconcileOrders, getDelayBadge, DelayBadgeInfo } from '../orderMatch';
import { lookupShipment, getShipmentBadge, normalizeName } from '../shipmentMatch';

const normalizeForSearch = (str: string): string => {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .replace(/[\u30a1-\u30f6]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0x60))
    .replace(/[\s\-_・]/g, '');
};

interface OrderManagementProps {
  stores: Store[];
  currentStoreId: string;
}

export const OrderManagement: React.FC<OrderManagementProps> = ({ stores, currentStoreId }) => {
  const [orders, setOrders] = useState<Order[]>([]);
  const [ignoredItems, setIgnoredItems] = useState<IgnoredOrderItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [marginDays, setMarginDays] = useState<number>(7);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'unfulfilled' | 'pending' | 'delayed' | 'partial' | 'fulfilled' | 'candidate' | 'cancelled'>('all');
  const [dateRangeFilter, setDateRangeFilter] = useState<'all' | '7days' | '14days' | '30days' | '90days' | 'thisMonth' | 'lastMonth' | 'custom'>('all');
  const [customStartDate, setCustomStartDate] = useState<string>('');
  const [customEndDate, setCustomEndDate] = useState<string>('');
  const [adjustingFilter, setAdjustingFilter] = useState<boolean>(false);
  const [shipmentMap, setShipmentMap] = useState<Map<string, ShipmentLookup>>(new Map());
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 20;
  const [uploadMessage, setUploadMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [selectedOrderForDetail, setSelectedOrderForDetail] = useState<{ order: Order; shipment?: ShipmentLookup } | null>(null);
  const [showIgnoredMasterModal, setShowIgnoredMasterModal] = useState<boolean>(false);

  // 一括除外確認モーダル用ステート
  const [showCandidateModal, setShowCandidateModal] = useState<boolean>(false);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(new Set());

  const currentStore = stores.find(s => s.id === currentStoreId);

  // 除外対象マスタの取得
  const fetchIgnoredItems = async () => {
    if (!currentStoreId) return;
    try {
      const { data, error } = await supabase
        .from('ignored_order_items')
        .select('*')
        .eq('store_id', currentStoreId);

      if (!error && data) {
        setIgnoredItems(data as IgnoredOrderItem[]);
      }
    } catch (e) {
      console.warn('fetchIgnoredItems warning:', e);
    }
  };

  // データ取得
  const fetchOrders = async () => {
    if (!currentStoreId) return;
    setLoading(true);
    try {
      await fetchIgnoredItems();

      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('store_id', currentStoreId)
        .order('order_date', { ascending: false });

      if (error) throw error;
      const fetchedOrders = (data as Order[]) || [];
      setOrders(fetchedOrders);

      // 出荷状況の突合
      if (fetchedOrders.length > 0) {
        const stocks = fetchedOrders.map(o => ({
          name: o.name,
          yakka_code: o.yakka_code || o.jan_code
        }));
        const lookups = await lookupShipment(stocks);
        const map = new Map<string, ShipmentLookup>();
        fetchedOrders.forEach((o, i) => {
          map.set(o.id, lookups[i]);
        });
        setShipmentMap(map);
      }
    } catch (err: any) {
      console.error('Fetch orders error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, [currentStoreId]);

  // 除外候補判定ヘルパー（一般用品・OTC医薬品・検査薬・雑品等の広域判定）
  const isExclusionCandidate = (ord: Order, lookup?: ShipmentLookup): boolean => {
    const name = ord.name || '';

    // 1. OTC医薬品・検査薬・自費品・一般用医薬品の包括的キーワード
    const otcRegex = /ノルレボ|エラワン|チェックワン|ドゥーテスト|ハイテスター|妊娠|排卵|自費|OTC|一般用|テストキット|検査薬|第[1１2２3３]類|類医薬品|指定第|外用薬|消毒液|マスク|サプリ|栄養|食品|化粧|資生堂|カネボウ|コーセー|ロート|アラクス|パブロン|新ルル|ルル|ガスター|ロキソニンS|ロキソニンＳ|アレグラFX|アレグラＦＸ|リアップ|チョコラ|アリナミン|ビオフェルミン|太田胃散|キャベジン/i;
    if (otcRegex.test(name)) return true;

    // 2. 厚労省の医療用医薬品マスタ（shipment_status）に一切ヒットしない商品 (kind === 'none')
    // 薬価削除品や非医療用品は kind === 'none' になります
    if (lookup && lookup.kind === 'none') {
      const isValidYj = /^[0-9A-Za-z]{12}$/.test((ord.yakka_code || ord.jan_code || '').trim());
      if (!isValidYj) return true;
    }

    return false;
  };

  // マスタ設定済み除外品判定
  const isAlreadyIgnored = (ord: Order): boolean => {
    return ignoredItems.some(ig => 
      (ig.jan_code && ig.jan_code === ord.jan_code) ||
      (ig.name_key && ord.name_key && ig.name_key === ord.name_key)
    );
  };

  // 除外候補の一括確認モーダルを開く
  const handleOpenCandidateModal = () => {
    const candidateOrders = orders.filter(o => 
      o.status !== 'cancelled' && 
      !isAlreadyIgnored(o) && 
      isExclusionCandidate(o, shipmentMap.get(o.id))
    );

    // OTC・検査薬・一般用品キーワードに合致するもののみ初期チェックON
    // 薬価削除品（EPLカプセル、キンダベート軟膏等）は誤チェック防止のため初期状態ではチェックOFF
    const initialCheckedIds = new Set<string>();
    const otcRegex = /ノルレボ|エラワン|チェックワン|ドゥーテスト|ハイテスター|妊娠|排卵|自費|OTC|一般用|テストキット|検査薬|第[1１2２3３]類|類医薬品|指定第|外用薬|消毒液|マスク|サプリ|栄養|食品|化粧|資生堂|カネボウ|コーセー|ロート|アラクス|パブロン|新ルル|ルル|ガスター|ロキソニンS|ロキソニンＳ|アレグラFX|アレグラＦＸ|リアップ|チョコラ|アリナミン|ビオフェルミン|太田胃散|キャベジン/i;

    candidateOrders.forEach(o => {
      if (otcRegex.test(o.name)) {
        initialCheckedIds.add(o.id);
      }
    });

    setSelectedCandidateIds(initialCheckedIds);
    setShowCandidateModal(true);
  };

  // 一括除外の確定処理
  const handleConfirmCandidateExclusion = async () => {
    if (selectedCandidateIds.size === 0) {
      alert('除外対象として選択された商品がありません');
      return;
    }

    const targetOrders = orders.filter(o => selectedCandidateIds.has(o.id));

    if (!window.confirm(`選択した ${targetOrders.length} 件を今後自動除外するマスタに登録し、対象外として確定しますか？`)) {
      return;
    }

    try {
      // 重複を除いてマスタ登録用の配列を作成
      const uniqueItemsMap = new Map<string, any>();
      targetOrders.forEach(o => {
        const key = o.jan_code || o.name_key || o.name;
        if (!uniqueItemsMap.has(key)) {
          uniqueItemsMap.set(key, {
            store_id: currentStoreId,
            jan_code: o.jan_code || null,
            name: o.name,
            name_key: o.name_key || normalizeName(o.name),
            reason: '一般品・OTC・検査薬（確認一括除外）',
            created_at: new Date().toISOString()
          });
        }
      });

      const newItems = Array.from(uniqueItemsMap.values());
      const { error: insertErr } = await supabase.from('ignored_order_items').insert(newItems);
      if (insertErr) throw insertErr;

      // 該当発注レコードのステータスを cancelled に更新
      const targetIds = Array.from(selectedCandidateIds);
      const { error: updateErr } = await supabase.from('orders').update({ status: 'cancelled' }).in('id', targetIds);
      if (updateErr) throw updateErr;

      setUploadMessage({ type: 'success', text: `${newItems.length} 品目を自動除外マスタに登録し、発注一覧から対象外に更新しました` });
      setShowCandidateModal(false);
      await fetchOrders();
    } catch (err: any) {
      alert(`除外登録失敗: ${err.message}`);
    }
  };

  // 単品での除外マスタ追加
  const handleAddToIgnored = async (order: Order, reason = '一般品・自費品（管理対象外）') => {
    if (!currentStoreId) return;
    try {
      const nameKey = order.name_key || normalizeName(order.name);
      const newItem = {
        store_id: currentStoreId,
        jan_code: order.jan_code || null,
        name: order.name,
        name_key: nameKey,
        reason,
        created_at: new Date().toISOString()
      };

      const { error } = await supabase.from('ignored_order_items').insert([newItem]);
      if (error) throw error;

      await supabase.from('orders').update({ status: 'cancelled' }).eq('id', order.id);

      setUploadMessage({ type: 'success', text: `「${order.name}」を今後自動除外するマスタに登録しました` });
      await fetchOrders();
    } catch (err: any) {
      alert(`除外登録に失敗しました: ${err.message}`);
    }
  };

  // 除外マスタから削除 (復元)
  const handleRemoveFromIgnored = async (item: IgnoredOrderItem) => {
    try {
      // 1. 除外マスタから削除
      const { error: delErr } = await supabase.from('ignored_order_items').delete().eq('id', item.id);
      if (delErr) throw delErr;

      // 2. 該当品目のキャンセル済み発注レコードを pending に復元
      let orderQuery = supabase
        .from('orders')
        .update({ status: 'pending', updated_at: new Date().toISOString() })
        .eq('store_id', currentStoreId)
        .eq('status', 'cancelled');

      if (item.jan_code) {
        orderQuery = orderQuery.eq('jan_code', item.jan_code);
      } else if (item.name_key) {
        orderQuery = orderQuery.eq('name_key', item.name_key);
      }

      const { error: updateErr } = await orderQuery;
      if (updateErr) console.warn('Order status restore warning:', updateErr);

      setUploadMessage({ type: 'success', text: `「${item.name}」を除外マスタから削除し、発注一覧へ復元しました` });

      // 3. 再照合を実行
      try {
        await reconcileOrders(currentStoreId, marginDays);
      } catch (rErr) {
        console.warn('Reconcile error after restore:', rErr);
      }

      await fetchOrders();
    } catch (err: any) {
      alert(`復元処理に失敗しました: ${err.message}`);
    }
  };

  // 発注一覧上の個別の「除外設定済み」行からの復元処理
  const handleRemoveFromIgnoredOrder = async (order: Order) => {
    try {
      // 1. 除外マスタから該当するJANコードまたは name_key の品目を削除
      if (order.jan_code) {
        await supabase
          .from('ignored_order_items')
          .delete()
          .eq('store_id', currentStoreId)
          .eq('jan_code', order.jan_code);
      }
      const nameKey = order.name_key || normalizeName(order.name);
      if (nameKey) {
        await supabase
          .from('ignored_order_items')
          .delete()
          .eq('store_id', currentStoreId)
          .eq('name_key', nameKey);
      }

      // 2. 発注レコードのステータスを pending に復元
      const { error: updateErr } = await supabase
        .from('orders')
        .update({ status: 'pending', updated_at: new Date().toISOString() })
        .eq('id', order.id);

      if (updateErr) throw updateErr;

      setUploadMessage({ type: 'success', text: `「${order.name}」を除外解除し、管理対象に復元しました` });

      // 3. 再照合を実行
      try {
        await reconcileOrders(currentStoreId, marginDays);
      } catch (rErr) {
        console.warn('Reconcile error after order restore:', rErr);
      }

      await fetchOrders();
    } catch (err: any) {
      alert(`除外解除に失敗しました: ${err.message}`);
    }
  };

  // CSV出力（現在表示・フィルタ中の照合データをCSV保存）
  const handleExportCsv = () => {
    if (filteredOrders.length === 0) {
      alert('出力対象のデータがありません');
      return;
    }

    const headers = [
      '発注日',
      '納品指定日',
      '実際の入庫日',
      '薬品名',
      '規格',
      'メーカー',
      'JANコード',
      '発注先卸',
      '発注数量',
      '納入数量',
      '納品ステータス',
      '納期遅延状況',
      '厚労省供給調整状況',
      '除外設定'
    ];

    const rows = filteredOrders.map(ord => {
      const delayBadge = getDelayBadge(ord);
      const shipmentLk = shipmentMap.get(ord.id);
      const shipmentBadge = shipmentLk ? getShipmentBadge(shipmentLk.rows) : null;
      const alreadyIgnored = isAlreadyIgnored(ord) || ord.status === 'cancelled';

      const statusText = 
        ord.status === 'fulfilled' ? '着荷完納' :
        ord.status === 'partial' ? '一部着荷' :
        ord.status === 'delayed' ? '納期遅延' :
        ord.status === 'cancelled' ? '管理対象外' : '未納品';

      return [
        ord.order_date || '',
        ord.delivery_date || '',
        ord.actual_delivery_date || '',
        ord.name || '',
        ord.spec || '',
        ord.maker || '',
        ord.jan_code || '',
        ord.supplier || '',
        ord.order_qty,
        ord.delivered_qty,
        statusText,
        alreadyIgnored ? '一般除外品' : delayBadge.label,
        shipmentBadge ? shipmentBadge.label : '通常出荷/データなし',
        alreadyIgnored ? '除外設定済み' : '対象'
      ];
    });

    const csvContent = '\uFEFF' + [
      headers.join(','),
      ...rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(','))
    ].join('\r\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const storeName = currentStore?.name || '店舗';
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    a.download = `発注未納品照合データ_${storeName}_${dateStr}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // PDF / 印刷出力
  const handlePrint = () => {
    if (filteredOrders.length === 0) {
      alert('印刷対象のデータがありません');
      return;
    }

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('ポップアップブロックを解除してください');
      return;
    }

    const storeName = currentStore?.name || '店舗';
    const today = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' });

    const rowsHtml = filteredOrders.map(ord => {
      const delayBadge = getDelayBadge(ord);
      const shipmentLk = shipmentMap.get(ord.id);
      const shipmentBadge = shipmentLk ? getShipmentBadge(shipmentLk.rows) : null;
      const alreadyIgnored = isAlreadyIgnored(ord) || ord.status === 'cancelled';

      const statusText = 
        ord.status === 'fulfilled' ? '着荷完納' :
        ord.status === 'partial' ? '一部着荷' :
        ord.status === 'delayed' ? '納期遅延' :
        ord.status === 'cancelled' ? '管理対象外' : '未納品';

      return `
        <tr>
          <td>${ord.order_date}<br/><span style="color:#64748b;font-size:10px;">指定:${ord.delivery_date}</span></td>
          <td style="font-weight:bold;">${ord.name}<br/><span style="color:#64748b;font-size:10px;">${ord.spec || ''} ${ord.maker ? '(' + ord.maker + ')' : ''}</span></td>
          <td style="font-family:monospace;">${ord.jan_code}</td>
          <td>${ord.supplier || '-'}</td>
          <td style="text-align:center;font-weight:bold;">${ord.delivered_qty} / ${ord.order_qty}</td>
          <td>${alreadyIgnored ? '一般除外品' : statusText + ' (' + delayBadge.label + ')'}</td>
          <td>${shipmentBadge ? shipmentBadge.label : '通常出荷'}</td>
        </tr>
      `;
    }).join('');

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8"/>
        <title>発注・未納品 照合データ報告書 - ${storeName}</title>
        <style>
          @page { size: A4 landscape; margin: 10mm; }
          body { font-family: "Helvetica Neue", Arial, "Hiragino Kaku Gothic ProN", "Hiragino Sans", Meiryo, sans-serif; font-size: 11px; color: #0f172a; margin: 0; padding: 0; }
          .header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #0f172a; padding-bottom: 8px; margin-bottom: 12px; }
          .title { font-size: 18px; font-weight: bold; color: #0f172a; }
          .sub { font-size: 11px; color: #475569; }
          .meta { text-align: right; font-size: 11px; }
          .summary-box { display: flex; gap: 20px; background: #f8fafc; border: 1px solid #cbd5e1; padding: 8px 14px; border-radius: 6px; margin-bottom: 12px; font-size: 11px; font-weight: bold; }
          table { width: 100%; border-collapse: collapse; margin-top: 4px; }
          th { background: #1e293b; color: #ffffff; padding: 6px 8px; text-align: left; font-size: 10px; border: 1px solid #0f172a; }
          td { padding: 6px 8px; border-bottom: 1px solid #cbd5e1; border-right: 1px solid #e2e8f0; border-left: 1px solid #e2e8f0; font-size: 10px; }
          tr:nth-child(even) { background-color: #f8fafc; }
          @media print {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <div class="title">発注・未納品 照合結果報告書</div>
            <div class="sub">対象店舗: ${storeName}</div>
          </div>
          <div class="meta">
            <div>出力日: ${today}</div>
            <div>対象件数: ${filteredOrders.length} 件</div>
          </div>
        </div>

        <div class="summary-box">
          <div>全発注数: ${stats.total}件</div>
          <div>未納品・遅延: <span style="color:#e11d48;">${stats.unfulfilledCount}件</span></div>
          <div>納期遅延: ${stats.delayed}件</div>
          <div>厚労省出荷調整対象: <span style="color:#7c3aed;">${stats.adjustingCount}件</span></div>
        </div>

        <table>
          <thead>
            <tr>
              <th style="width:13%;">発注日 / 指定日</th>
              <th style="width:30%;">薬品名 / 規格 / メーカー</th>
              <th style="width:13%;">JANコード</th>
              <th style="width:12%;">発注先卸</th>
              <th style="width:10%;text-align:center;">納品数 / 発注数</th>
              <th style="width:12%;">納品状態 / 遅延</th>
              <th style="width:10%;">出荷調整</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>

        <script>
          window.onload = () => {
            setTimeout(() => {
              window.print();
            }, 300);
          };
        </script>
      </body>
      </html>
    `;

    printWindow.document.open();
    printWindow.document.write(htmlContent);
    printWindow.document.close();
  };

  // CSVインポート処理
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    if (!currentStoreId) {
      setUploadMessage({ type: 'error', text: '店舗が選択されていません' });
      return;
    }

    setLoading(true);
    setUploadMessage(null);

    const { data: existingDbOrders } = await supabase
      .from('orders')
      .select('*')
      .eq('store_id', currentStoreId);

    const existingPool = [...((existingDbOrders as Order[]) || [])];

    const { data: latestIgnored } = await supabase
      .from('ignored_order_items')
      .select('*')
      .eq('store_id', currentStoreId);
    const ignoredList = (latestIgnored as IgnoredOrderItem[]) || [];

    let totalImported = 0;
    let autoIgnoredCount = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const text = await readFileWithEncoding(file);
        const parsedRows = parseOrderCsv(text);

        if (parsedRows.length === 0) continue;

        const updates: Partial<Order>[] = [];
        const inserts: Omit<Order, 'id'>[] = [];

        parsedRows.forEach(r => {
          const isIgnoredByMaster = ignoredList.some(ig => 
            (ig.jan_code && ig.jan_code === r.jan_code) ||
            (ig.name_key && ig.name_key === r.name_key)
          );

          if (isIgnoredByMaster) {
            autoIgnoredCount++;
          }

          const initialStatus: OrderStatus = isIgnoredByMaster ? 'cancelled' : 'pending';

          const matchIdx = existingPool.findIndex(o => 
            o.store_id === currentStoreId &&
            o.order_date === r.order_date &&
            o.jan_code === r.jan_code &&
            o.order_qty === r.order_qty
          );

          if (matchIdx !== -1) {
            const existing = existingPool[matchIdx];
            existingPool.splice(matchIdx, 1);

            updates.push({
              id: existing.id,
              store_id: currentStoreId,
              order_date: r.order_date,
              order_time: r.order_time || existing.order_time,
              delivery_date: r.delivery_date,
              actual_delivery_date: existing.actual_delivery_date,
              delay_days: existing.delay_days,
              jan_code: r.jan_code,
              name: r.name,
              name_key: r.name_key,
              spec: r.spec || existing.spec,
              maker: r.maker || existing.maker,
              supplier: r.supplier || existing.supplier,
              order_qty: r.order_qty,
              delivered_qty: existing.delivered_qty,
              status: existing.status === 'fulfilled' || existing.status === 'partial' ? existing.status : initialStatus,
              source_file: file.name,
              updated_at: new Date().toISOString()
            });
          } else {
            inserts.push({
              store_id: currentStoreId,
              order_date: r.order_date,
              order_time: r.order_time,
              delivery_date: r.delivery_date,
              jan_code: r.jan_code,
              name: r.name,
              name_key: r.name_key,
              spec: r.spec,
              maker: r.maker,
              supplier: r.supplier,
              order_qty: r.order_qty,
              delivered_qty: 0,
              status: initialStatus,
              source_file: file.name,
              updated_at: new Date().toISOString()
            });
          }
        });

        if (updates.length > 0) {
          const { error: updateErr } = await supabase.from('orders').upsert(updates);
          if (updateErr) throw new Error(`更新失敗: ${updateErr.message}`);
        }

        if (inserts.length > 0) {
          const { error: insertErr } = await supabase.from('orders').insert(inserts);
          if (insertErr) throw new Error(`新規登録失敗: ${insertErr.message}`);
        }

        totalImported += parsedRows.length;
      } catch (err: any) {
        console.error(`Error processing file ${file.name}:`, err);
        setUploadMessage({ type: 'error', text: `${file.name} の保存に失敗しました: ${err.message}` });
        setLoading(false);
        event.target.value = '';
        return;
      }
    }

    if (totalImported > 0) {
      let msg = `${totalImported} 件の発注データをインポートしました。`;
      if (autoIgnoredCount > 0) {
        msg += ` (${autoIgnoredCount} 件を除外マスタに基づき自動除外)`;
      }
      setUploadMessage({ type: 'success', text: `${msg} 照合を実行中...` });

      try {
        const result = await reconcileOrders(currentStoreId, marginDays);
        setUploadMessage({ type: 'success', text: `${msg} 照合完了（${result.updatedCount} 件を更新）` });
      } catch (rErr) {
        console.error('Auto reconcile error:', rErr);
      }
      await fetchOrders();
    }
    setLoading(false);
    event.target.value = '';
  };

  // エンコーディング解読付きファイル読み込み
  const readFileWithEncoding = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const buffer = e.target?.result as ArrayBuffer;
        const sjisDecoder = new TextDecoder('shift-jis');
        const sjisText = sjisDecoder.decode(buffer);

        if (/発注|品名|商品コード|発注数量|納品/.test(sjisText) && !sjisText.includes('\uFFFD')) {
          resolve(sjisText);
          return;
        }

        const utf8Decoder = new TextDecoder('utf-8');
        const utf8Text = utf8Decoder.decode(buffer);
        if (/発注|品名|商品コード|発注数量|納品/.test(utf8Text)) {
          resolve(utf8Text);
          return;
        }

        resolve(sjisText);
      };
      reader.onerror = (err) => reject(err);
      reader.readAsArrayBuffer(file);
    });
  };

  // 手動照合実行
  const handleReconcile = async () => {
    if (!currentStoreId) return;
    setReconciling(true);
    try {
      const result = await reconcileOrders(currentStoreId, marginDays);
      setUploadMessage({ type: 'success', text: `照合を完了しました（更新: ${result.updatedCount} 件）` });
      await fetchOrders();
    } catch (err: any) {
      console.error('Reconcile error:', err);
      setUploadMessage({ type: 'error', text: `照合処理でエラーが発生しました: ${err.message}` });
    } finally {
      setReconciling(false);
    }
  };

  // 手動ステータス変更
  const handleStatusChange = async (orderId: string, newStatus: OrderStatus) => {
    try {
      const patch: Partial<Order> = {
        status: newStatus,
        updated_at: new Date().toISOString()
      };
      if (newStatus === 'fulfilled') {
        const target = orders.find(o => o.id === orderId);
        if (target) patch.delivered_qty = target.order_qty;
        if (!patch.actual_delivery_date) patch.actual_delivery_date = new Date().toISOString().slice(0, 10);
      }

      const { error } = await supabase.from('orders').update(patch).eq('id', orderId);
      if (error) throw error;

      setOrders(prev => prev.map(o => o.id === orderId ? { ...o, ...patch } : o));
    } catch (err: any) {
      alert(`ステータス更新失敗: ${err.message}`);
    }
  };

  // 1件削除
  const handleDeleteOrder = async (orderId: string) => {
    if (!window.confirm('この発注レコードを削除しますか？')) return;
    try {
      const { error } = await supabase.from('orders').delete().eq('id', orderId);
      if (error) throw error;
      setOrders(prev => prev.filter(o => o.id !== orderId));
    } catch (err: any) {
      alert(`削除失敗: ${err.message}`);
    }
  };

  // フィルタリング処理
  const filteredOrders = useMemo(() => {
    return orders.filter(ord => {
      // 検索ワード（全角半角・ひらがなカタカナ・メーカー・卸名を柔軟に照合）
      if (searchQuery.trim()) {
        const q = normalizeForSearch(searchQuery);
        const matchName = normalizeForSearch(ord.name).includes(q);
        const matchNameKey = normalizeForSearch(ord.name_key || '').includes(q);
        const matchJan = (ord.jan_code || '').includes(searchQuery.trim());
        const matchMaker = normalizeForSearch(ord.maker || '').includes(q);
        const matchSupplier = normalizeForSearch(ord.supplier || '').includes(q);
        if (!matchName && !matchNameKey && !matchJan && !matchMaker && !matchSupplier) return false;
      }

      // 日付期間フィルタ
      if (dateRangeFilter !== 'all') {
        const ordDateStr = (ord.order_date || '').replace(/\//g, '-');
        if (!ordDateStr) return false;

        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10);

        if (dateRangeFilter === '7days') {
          const past = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          if (ordDateStr < past || ordDateStr > todayStr) return false;
        } else if (dateRangeFilter === '14days') {
          const past = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          if (ordDateStr < past || ordDateStr > todayStr) return false;
        } else if (dateRangeFilter === '30days') {
          const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          if (ordDateStr < past || ordDateStr > todayStr) return false;
        } else if (dateRangeFilter === '90days') {
          const past = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          if (ordDateStr < past || ordDateStr > todayStr) return false;
        } else if (dateRangeFilter === 'thisMonth') {
          const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
          if (ordDateStr < startOfMonth || ordDateStr > todayStr) return false;
        } else if (dateRangeFilter === 'lastMonth') {
          const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
          const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);
          if (ordDateStr < startOfLastMonth || ordDateStr > endOfLastMonth) return false;
        } else if (dateRangeFilter === 'custom') {
          if (customStartDate && ordDateStr < customStartDate) return false;
          if (customEndDate && ordDateStr > customEndDate) return false;
        }
      }

      // 除外候補フィルタ
      if (statusFilter === 'candidate') {
        const lk = shipmentMap.get(ord.id);
        if (!isExclusionCandidate(ord, lk) || ord.status === 'cancelled') return false;
        return true;
      }

      // 除外済みフィルタ
      if (statusFilter === 'cancelled') {
        if (ord.status !== 'cancelled' && !isAlreadyIgnored(ord)) return false;
        return true;
      }

      // 通常時はキャンセル（除外済み）は非表示
      if (ord.status === 'cancelled' && statusFilter !== 'cancelled') return false;

      // ステータスフィルタ
      if (statusFilter === 'unfulfilled') {
        if (ord.status === 'fulfilled' || ord.status === 'cancelled') return false;
      } else if (statusFilter !== 'all') {
        if (ord.status !== statusFilter) return false;
      }

      // 出荷調整中フィルタ
      if (adjustingFilter) {
        const lookup = shipmentMap.get(ord.id);
        const badge = lookup ? getShipmentBadge(lookup.rows) : null;
        if (!badge) return false;
      }

      return true;
    });
  }, [orders, searchQuery, statusFilter, dateRangeFilter, customStartDate, customEndDate, adjustingFilter, shipmentMap, ignoredItems]);

  // サマリー計算
  const stats = useMemo(() => {
    const activeOrders = orders.filter(o => {
      if (o.status === 'cancelled') return false;
      if (dateRangeFilter !== 'all') {
        const ordDateStr = (o.order_date || '').replace(/\//g, '-');
        if (!ordDateStr) return false;

        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10);

        if (dateRangeFilter === '7days') {
          const past = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          if (ordDateStr < past || ordDateStr > todayStr) return false;
        } else if (dateRangeFilter === '14days') {
          const past = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          if (ordDateStr < past || ordDateStr > todayStr) return false;
        } else if (dateRangeFilter === '30days') {
          const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          if (ordDateStr < past || ordDateStr > todayStr) return false;
        } else if (dateRangeFilter === '90days') {
          const past = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          if (ordDateStr < past || ordDateStr > todayStr) return false;
        } else if (dateRangeFilter === 'thisMonth') {
          const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
          if (ordDateStr < startOfMonth || ordDateStr > todayStr) return false;
        } else if (dateRangeFilter === 'lastMonth') {
          const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
          const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);
          if (ordDateStr < startOfLastMonth || ordDateStr > endOfLastMonth) return false;
        } else if (dateRangeFilter === 'custom') {
          if (customStartDate && ordDateStr < customStartDate) return false;
          if (customEndDate && ordDateStr > customEndDate) return false;
        }
      }
      return true;
    });

    const total = activeOrders.length;
    const pending = activeOrders.filter(o => o.status === 'pending').length;
    const delayed = activeOrders.filter(o => o.status === 'delayed').length;
    const partial = activeOrders.filter(o => o.status === 'partial').length;
    const fulfilled = activeOrders.filter(o => o.status === 'fulfilled').length;
    const unfulfilledCount = pending + delayed + partial;

    let candidateCount = 0;
    activeOrders.forEach(o => {
      const lk = shipmentMap.get(o.id);
      if (isExclusionCandidate(o, lk)) candidateCount++;
    });

    let adjustingCount = 0;
    activeOrders.forEach(o => {
      const lk = shipmentMap.get(o.id);
      if (lk && getShipmentBadge(lk.rows)) adjustingCount++;
    });

    return { total, unfulfilledCount, pending, delayed, partial, fulfilled, candidateCount, adjustingCount };
  }, [orders, shipmentMap, dateRangeFilter, customStartDate, customEndDate]);

  // モーダル用候補オーダー一覧
  const candidateOrders = useMemo(() => {
    return orders.filter(o => 
      o.status !== 'cancelled' && 
      !isAlreadyIgnored(o) && 
      isExclusionCandidate(o, shipmentMap.get(o.id))
    );
  }, [orders, shipmentMap, ignoredItems]);

  // ページネーション
  const totalPages = Math.ceil(filteredOrders.length / itemsPerPage) || 1;
  const [pageInput, setPageInput] = useState<string>('1');

  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  const handlePageSubmit = () => {
    const parsed = parseInt(pageInput, 10);
    if (isNaN(parsed)) {
      setPageInput(String(currentPage));
      return;
    }
    const clamped = Math.max(1, Math.min(totalPages, parsed));
    setCurrentPage(clamped);
    setPageInput(String(clamped));
  };

  const paginatedOrders = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredOrders.slice(start, start + itemsPerPage);
  }, [filteredOrders, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, statusFilter, adjustingFilter, dateRangeFilter, customStartDate, customEndDate]);

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1600px] mx-auto">
      {/* ヘッダーエリア */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-900 text-white p-5 rounded-2xl shadow-xl border border-slate-800">
        <div>
          <div className="flex items-center gap-2">
            <PackageCheck className="w-7 h-7 text-emerald-400" />
            <h1 className="text-2xl font-black tracking-wide">発注・未納品管理</h1>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            発注CSVデータを入庫履歴と照合し、未納品・納期ズレ・出荷調整および一般除外品を管理します
          </p>
        </div>

        {/* ボタン群 */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => setShowIgnoredMasterModal(true)}
            className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/40 text-xs font-bold px-3.5 py-2.5 rounded-xl shadow transition-all"
          >
            <ShieldAlert className="w-4 h-4 text-amber-400" />
            <span>除外マスタ設定 ({ignoredItems.length}件)</span>
          </button>

          <label className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-4 py-2.5 rounded-xl cursor-pointer shadow-lg transition-all transform hover:-translate-y-0.5 text-sm">
            <Upload className="w-4 h-4" />
            <span>発注CSVインポート</span>
            <input 
              type="file" 
              accept=".csv" 
              multiple 
              onChange={handleFileUpload} 
              className="hidden" 
              disabled={loading}
            />
          </label>

          <div className="flex items-center gap-2 bg-slate-800 p-1.5 rounded-xl border border-slate-700">
            <span className="text-xs text-slate-300 font-bold pl-2">照合範囲:</span>
            <select
              value={marginDays}
              onChange={(e) => setMarginDays(Number(e.target.value))}
              className="bg-slate-900 text-xs text-white px-2 py-1.5 rounded-lg border border-slate-700 font-bold focus:outline-none focus:border-emerald-500"
            >
              <option value={3}>指定日+3日</option>
              <option value={7}>指定日+7日 (標準)</option>
              <option value={14}>指定日+14日</option>
              <option value={30}>指定日+30日</option>
              <option value={999}>全期間</option>
            </select>
            <button
              onClick={handleReconcile}
              disabled={reconciling || orders.length === 0}
              className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold px-3 py-1.5 rounded-lg shadow transition-all disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${reconciling ? 'animate-spin' : ''}`} />
              <span>照合実行</span>
            </button>
          </div>

          {/* 出力ボタン群 */}
          <button
            onClick={handleExportCsv}
            disabled={filteredOrders.length === 0}
            className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-emerald-500/40 text-xs font-bold px-3.5 py-2.5 rounded-xl shadow transition-all disabled:opacity-40"
            title="現在表示・フィルタ中の照合データをCSV出力"
          >
            <Download className="w-4 h-4 text-emerald-400" />
            <span>CSV出力</span>
          </button>

          <button
            onClick={handlePrint}
            disabled={filteredOrders.length === 0}
            className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-sky-300 border border-sky-500/40 text-xs font-bold px-3.5 py-2.5 rounded-xl shadow transition-all disabled:opacity-40"
            title="照合結果をPDF/印刷出力"
          >
            <Printer className="w-4 h-4 text-sky-400" />
            <span>PDF / 印刷</span>
          </button>
        </div>
      </div>

      {/* アラート・メッセージ */}
      {uploadMessage && (
        <div className={`p-4 rounded-xl text-sm font-bold flex items-center gap-3 shadow-md ${
          uploadMessage.type === 'success' 
            ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-700/50' 
            : 'bg-rose-900/40 text-rose-300 border border-rose-700/50'
        }`}>
          {uploadMessage.type === 'success' ? <CheckCircle2 className="w-5 h-5 flex-shrink-0" /> : <AlertCircle className="w-5 h-5 flex-shrink-0" />}
          <span className="flex-1">{uploadMessage.text}</span>
          <button onClick={() => setUploadMessage(null)} className="text-xs opacity-70 hover:opacity-100">✕</button>
        </div>
      )}

      {/* サマリーカード */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-2xl shadow-lg">
          <div className="text-xs font-bold text-slate-400">対象発注件数</div>
          <div className="text-2xl font-black text-white mt-1">{stats.total} <span className="text-xs font-normal text-slate-400">件</span></div>
        </div>
        <div className="bg-rose-950/40 border border-rose-800/50 p-4 rounded-2xl shadow-lg">
          <div className="text-xs font-bold text-rose-300 flex items-center gap-1">
            <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
            <span>未納品・遅延</span>
          </div>
          <div className="text-2xl font-black text-rose-200 mt-1">{stats.unfulfilledCount} <span className="text-xs font-normal text-rose-400">件</span></div>
        </div>
        <div className="bg-amber-950/40 border border-amber-800/50 p-4 rounded-2xl shadow-lg">
          <div className="text-xs font-bold text-amber-300 flex items-center gap-1">
            <Clock className="w-3.5 h-3.5 text-amber-400" />
            <span>分納中</span>
          </div>
          <div className="text-2xl font-black text-amber-200 mt-1">{stats.partial} <span className="text-xs font-normal text-amber-400">件</span></div>
        </div>
        <div className="bg-emerald-950/40 border border-emerald-800/50 p-4 rounded-2xl shadow-lg">
          <div className="text-xs font-bold text-emerald-300 flex items-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            <span>納品完了</span>
          </div>
          <div className="text-2xl font-black text-emerald-200 mt-1">{stats.fulfilled} <span className="text-xs font-normal text-emerald-400">件</span></div>
        </div>
        <div className="bg-purple-950/40 border border-purple-800/50 p-4 rounded-2xl shadow-lg col-span-2 md:col-span-1">
          <div className="text-xs font-bold text-purple-300 flex items-center gap-1">
            <AlertCircle className="w-3.5 h-3.5 text-purple-400" />
            <span>厚労省 出荷調整中</span>
          </div>
          <div className="text-2xl font-black text-purple-200 mt-1">{stats.adjustingCount} <span className="text-xs font-normal text-purple-400">品目</span></div>
        </div>
      </div>

      {/* フィルタ & 検索バー */}
      <div className="bg-slate-900/90 border border-slate-800 p-5 rounded-2xl shadow-xl space-y-4">
        {/* 検索バー (画面横幅いっぱいの独立・最優先検索エリア) */}
        <div className="relative w-full">
          <Search className="w-5 h-5 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="🔍 薬品名・規格・JANコード・メーカー・納品先卸名でリアルタイム検索..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-800/90 border-2 border-slate-700 focus:border-emerald-500 text-white placeholder-slate-400 pl-11 pr-24 py-3 rounded-2xl text-sm md:text-base font-bold shadow-inner focus:outline-none transition-all"
          />
          {searchQuery && (
            <div className="absolute right-3.5 top-1/2 -translate-y-1/2 flex items-center gap-2">
              <span className="text-xs text-emerald-400 font-black bg-emerald-950 border border-emerald-700/80 px-2.5 py-1 rounded-full shadow">
                {filteredOrders.length} 件ヒット
              </span>
              <button
                onClick={() => setSearchQuery('')}
                className="text-slate-400 hover:text-white hover:bg-slate-700 p-1 rounded-full transition-all text-xs font-bold"
                title="検索をクリア"
              >
                ✕
              </button>
            </div>
          )}
        </div>

        {/* フィルタボタン群（2段目に余裕を持って配置） */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-slate-800/80">
          {/* 表示期間選択 */}
          <div className="flex items-center gap-1.5 bg-slate-800 px-3 py-1.5 rounded-xl border border-slate-700 text-xs font-bold">
            <Calendar className="w-4 h-4 text-emerald-400" />
            <span className="text-slate-300">表示期間:</span>
            <select
              value={dateRangeFilter}
              onChange={(e) => setDateRangeFilter(e.target.value as any)}
              className="bg-slate-900 text-xs text-white px-2.5 py-1 rounded-lg border border-slate-700 font-bold focus:outline-none focus:border-emerald-500 cursor-pointer"
            >
              <option value="all">全期間 (すべて表示)</option>
              <option value="7days">直近1週間 (過去7日間)</option>
              <option value="14days">直近2週間 (過去14日間)</option>
              <option value="30days">直近1ヶ月 (過去30日間)</option>
              <option value="90days">直近3ヶ月 (過去90日間)</option>
              <option value="thisMonth">今月 (当月発注分)</option>
              <option value="lastMonth">先月 (前月発注分)</option>
              <option value="custom">日付指定 (期間入力)</option>
            </select>
          </div>

          {dateRangeFilter === 'custom' && (
            <div className="flex items-center gap-1.5 bg-slate-800 px-3 py-1.5 rounded-xl border border-slate-700 text-xs font-bold">
              <span className="text-slate-400">期間:</span>
              <input
                type="date"
                value={customStartDate}
                onChange={(e) => setCustomStartDate(e.target.value)}
                className="bg-slate-900 text-xs text-white px-2 py-1 rounded-lg border border-slate-700 font-bold focus:outline-none focus:border-emerald-500"
              />
              <span className="text-slate-400">〜</span>
              <input
                type="date"
                value={customEndDate}
                onChange={(e) => setCustomEndDate(e.target.value)}
                className="bg-slate-900 text-xs text-white px-2 py-1 rounded-lg border border-slate-700 font-bold focus:outline-none focus:border-emerald-500"
              />
            </div>
          )}

          {/* ステータス絞り込み & オプションボタン */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex bg-slate-800 p-1 rounded-xl border border-slate-700">
              <button
                onClick={() => setStatusFilter('all')}
                className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${
                  statusFilter === 'all' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-white'
                }`}
              >
                すべて
              </button>
              <button
                onClick={() => setStatusFilter('unfulfilled')}
                className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${
                  statusFilter === 'unfulfilled' ? 'bg-rose-600 text-white shadow' : 'text-slate-400 hover:text-white'
                }`}
              >
                未完納 ({stats.unfulfilledCount})
              </button>
              <button
                onClick={() => setStatusFilter('fulfilled')}
                className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${
                  statusFilter === 'fulfilled' ? 'bg-emerald-600 text-white shadow' : 'text-slate-400 hover:text-white'
                }`}
              >
                完納
              </button>
              <button
                onClick={() => setStatusFilter('candidate')}
                className={`flex items-center gap-1 px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${
                  statusFilter === 'candidate' ? 'bg-amber-600 text-white shadow' : 'text-amber-400 hover:text-white'
                }`}
              >
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>除外候補 ({stats.candidateCount})</span>
              </button>
              <button
                onClick={() => setStatusFilter('cancelled')}
                className={`flex items-center gap-1 px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${
                  statusFilter === 'cancelled' ? 'bg-slate-600 text-white shadow' : 'text-slate-400 hover:text-white'
                }`}
              >
                <EyeOff className="w-3.5 h-3.5" />
                <span>除外済み</span>
              </button>
            </div>

            <button
              onClick={() => setAdjustingFilter(!adjustingFilter)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-xl border transition-all ${
                adjustingFilter 
                  ? 'bg-purple-900/60 text-purple-200 border-purple-500 shadow' 
                  : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'
              }`}
            >
              <AlertCircle className="w-3.5 h-3.5 text-purple-400" />
              <span>出荷調整中のみ ({stats.adjustingCount})</span>
            </button>

            {stats.candidateCount > 0 && (
              <button
                onClick={handleOpenCandidateModal}
                className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold rounded-xl bg-amber-600 hover:bg-amber-500 text-white shadow transition-all transform hover:scale-105"
              >
                <ShieldAlert className="w-4 h-4" />
                <span>除外候補を確認・一括選択 ({stats.candidateCount}件)</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* メインテーブル */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-slate-400 font-bold animate-pulse">
            発注データを読み込み中...
          </div>
        ) : filteredOrders.length === 0 ? (
          <div className="p-12 text-center text-slate-400 font-medium">
            該当する発注データが見つかりません。
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-200 border-collapse">
                <thead>
                  <tr className="bg-slate-800/80 text-slate-300 font-bold border-b border-slate-700">
                    <th className="py-3 px-4">発注日 / 指定日</th>
                    <th className="py-3 px-4">薬品名 / 規格 / メーカー</th>
                    <th className="py-3 px-4">JANコード</th>
                    <th className="py-3 px-4">発注先卸</th>
                    <th className="py-3 px-4 text-center">納品数 / 発注数</th>
                    <th className="py-3 px-4">納品状態 & 遅延ラグ</th>
                    <th className="py-3 px-4">厚労省 出荷調整状況</th>
                    <th className="py-3 px-4 text-center">除外設定 & 操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-medium">
                  {paginatedOrders.map((ord) => {
                    const delayBadge = getDelayBadge(ord);
                    const shipmentLk = shipmentMap.get(ord.id);
                    const shipmentBadge = shipmentLk ? getShipmentBadge(shipmentLk.rows) : null;
                    const candidate = isExclusionCandidate(ord, shipmentLk);
                    const alreadyIgnored = isAlreadyIgnored(ord) || ord.status === 'cancelled';

                    return (
                      <tr 
                        key={ord.id}
                        className={`hover:bg-slate-800/40 transition-colors ${alreadyIgnored ? 'opacity-50 bg-slate-950/40' : ''}`}
                      >
                        {/* 日付 */}
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          <div className="font-bold text-white">{ord.order_date}</div>
                          <div className="text-[11px] text-slate-400 flex items-center gap-1 mt-0.5">
                            <span>指定:</span>
                            <span className="font-semibold text-slate-300">{ord.delivery_date}</span>
                          </div>
                        </td>

                        {/* 薬品名 */}
                        <td className="py-3.5 px-4">
                          <div className="flex items-center gap-2">
                            <div 
                              className="font-bold text-emerald-400 hover:underline cursor-pointer text-sm"
                              onClick={() => setSelectedOrderForDetail({ order: ord, shipment: shipmentLk })}
                            >
                              {ord.name}
                            </div>

                            {candidate && !alreadyIgnored && (
                              <span className="bg-amber-950 text-amber-300 border border-amber-700/60 px-2 py-0.5 rounded text-[10px] font-bold flex items-center gap-0.5">
                                <ShieldAlert className="w-3 h-3 text-amber-400" />
                                <span>除外候補</span>
                              </span>
                            )}

                            {alreadyIgnored && (
                              <span className="bg-slate-800 text-slate-400 border border-slate-700 px-2 py-0.5 rounded text-[10px] font-bold flex items-center gap-0.5">
                                <EyeOff className="w-3 h-3" />
                                <span>除外設定済み</span>
                              </span>
                            )}
                          </div>

                          <div className="text-[11px] text-slate-400 flex flex-wrap gap-2 mt-0.5">
                            {ord.spec && <span>規格: {ord.spec}</span>}
                            {ord.maker && <span>メーカー: {ord.maker}</span>}
                          </div>
                        </td>

                        {/* JAN */}
                        <td className="py-3.5 px-4 whitespace-nowrap font-mono text-slate-300">
                          {ord.jan_code}
                        </td>

                        {/* 発注先卸 */}
                        <td className="py-3.5 px-4 whitespace-nowrap text-slate-300">
                          {ord.supplier || '-'}
                        </td>

                        {/* 数量 */}
                        <td className="py-3.5 px-4 text-center whitespace-nowrap">
                          <div className="font-black text-sm text-white">
                            {ord.delivered_qty} / {ord.order_qty}
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {ord.delivered_qty >= ord.order_qty ? '全量着荷' : ord.delivered_qty > 0 ? '一部着荷' : '未着荷'}
                          </div>
                        </td>

                        {/* 納品状態 & ラグ */}
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          {alreadyIgnored ? (
                            <span className="text-slate-500 text-xs font-bold">一般除外品</span>
                          ) : (
                            <div className="flex flex-col gap-1 items-start">
                              <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold shadow-sm ${
                                delayBadge.level === 'on_time' ? 'bg-emerald-900/60 text-emerald-300 border border-emerald-700' :
                                delayBadge.level === 'slight_delay' ? 'bg-amber-900/60 text-amber-300 border border-amber-700' :
                                delayBadge.level === 'severe_delay' ? 'bg-rose-900/60 text-rose-300 border border-rose-700 animate-pulse' :
                                delayBadge.level === 'pending_overdue' ? 'bg-rose-950 text-rose-400 border border-rose-800' :
                                delayBadge.level === 'early' ? 'bg-blue-900/60 text-blue-300 border border-blue-700' :
                                'bg-slate-800 text-slate-300 border border-slate-700'
                              }`}>
                                <Clock className="w-3 h-3" />
                                {delayBadge.label}
                              </span>
                              {ord.actual_delivery_date && (
                                <span className="text-[10px] text-slate-400">
                                  入庫日: {ord.actual_delivery_date}
                                </span>
                              )}
                            </div>
                          )}
                        </td>

                        {/* 厚労省出荷調整バッジ */}
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          {shipmentBadge ? (
                            <button
                              onClick={() => setSelectedOrderForDetail({ order: ord, shipment: shipmentLk })}
                              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-all transform hover:scale-105 ${
                                shipmentBadge.level === 'stop' 
                                  ? 'bg-rose-950 text-rose-300 border-rose-600 hover:bg-rose-900' 
                                  : shipmentBadge.level === 'limited' 
                                  ? 'bg-purple-950 text-purple-300 border-purple-600 hover:bg-purple-900' 
                                  : 'bg-amber-950 text-amber-300 border-amber-600 hover:bg-amber-900'
                              }`}
                            >
                              <AlertCircle className="w-3 h-3" />
                              <span>{shipmentBadge.label}</span>
                              <Info className="w-3 h-3 ml-0.5 opacity-70" />
                            </button>
                          ) : (
                            <span className="text-slate-500 text-[11px]">通常出荷 / データなし</span>
                          )}
                        </td>

                        {/* 操作・除外登録 */}
                        <td className="py-3.5 px-4 text-center whitespace-nowrap">
                          <div className="flex items-center justify-center gap-1.5">
                            {!alreadyIgnored ? (
                              <button
                                onClick={() => handleAddToIgnored(ord)}
                                title="次回から自動で除外する対象マスタに登録"
                                className="flex items-center gap-1 px-2 py-1 bg-amber-950/70 hover:bg-amber-900 text-amber-300 rounded-lg text-[11px] font-bold border border-amber-700/60 transition-colors"
                              >
                                <ShieldAlert className="w-3 h-3 text-amber-400" />
                                <span>除外設定</span>
                              </button>
                            ) : (
                              <button
                                onClick={() => handleRemoveFromIgnoredOrder(ord)}
                                title="除外設定を解除して管理対象に復元"
                                className="flex items-center gap-1 px-2 py-1 bg-emerald-950/70 hover:bg-emerald-900 text-emerald-300 rounded-lg text-[11px] font-bold border border-emerald-700/60 transition-colors"
                              >
                                <ShieldCheck className="w-3 h-3 text-emerald-400" />
                                <span>除外解除（復元）</span>
                              </button>
                            )}

                            {ord.status !== 'fulfilled' && !alreadyIgnored && (
                              <button
                                onClick={() => handleStatusChange(ord.id, 'fulfilled')}
                                title="手動で完納にする"
                                className="p-1.5 bg-emerald-800/50 hover:bg-emerald-700 text-emerald-300 rounded-lg transition-colors border border-emerald-600/40"
                              >
                                <Check className="w-3.5 h-3.5" />
                              </button>
                            )}

                            <button
                              onClick={() => handleDeleteOrder(ord.id)}
                              title="削除"
                              className="p-1.5 bg-rose-950/60 hover:bg-rose-900 text-rose-400 rounded-lg transition-colors border border-rose-800/40"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* ページネーションバー */}
            <div className="p-4 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-3 bg-slate-900/50">
              <div className="text-xs text-slate-400 font-medium">
                全 {filteredOrders.length} 件中 {((currentPage - 1) * itemsPerPage) + 1} - {Math.min(currentPage * itemsPerPage, filteredOrders.length)} 件を表示
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800 transition-colors"
                  title="前ページ"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>

                <div className="flex items-center gap-1.5 text-xs font-bold text-slate-300 bg-slate-800/80 px-2.5 py-1 rounded-xl border border-slate-700">
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={pageInput}
                    onChange={(e) => {
                      const converted = e.target.value.replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).replace(/[^0-9]/g, '');
                      setPageInput(converted);
                    }}
                    onBlur={handlePageSubmit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handlePageSubmit();
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    className="w-14 bg-slate-900 text-center text-white text-xs font-bold py-0.5 rounded border border-slate-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 font-mono"
                  />
                  <span className="text-slate-400">/ {totalPages} ページ</span>
                </div>

                <button
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800 transition-colors"
                  title="次ページ"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* 除外候補の確認・一括登録モーダル */}
      {showCandidateModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-3xl w-full max-h-[85vh] flex flex-col p-6 shadow-2xl text-slate-200">
            <div className="flex items-start justify-between border-b border-slate-800 pb-3 flex-shrink-0">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-6 h-6 text-amber-400" />
                <div>
                  <h3 className="text-lg font-black text-white">除外候補の目視確認・一括設定</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    一般品・OTC・検査薬等の候補です。除外したくない医薬品（キンダベート・EPL等）はチェックを外してください。
                  </p>
                </div>
              </div>
              <button 
                onClick={() => setShowCandidateModal(false)}
                className="text-slate-400 hover:text-white font-bold p-1 rounded-lg"
              >
                ✕
              </button>
            </div>

            {/* チェック一括操作 */}
            <div className="flex items-center justify-between bg-slate-800/80 p-3 rounded-xl border border-slate-700/60 text-xs font-bold flex-shrink-0 my-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    if (selectedCandidateIds.size === candidateOrders.length) {
                      setSelectedCandidateIds(new Set());
                    } else {
                      setSelectedCandidateIds(new Set(candidateOrders.map(o => o.id)));
                    }
                  }}
                  className="flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded-lg text-white transition-colors"
                >
                  {selectedCandidateIds.size === candidateOrders.length ? (
                    <>
                      <CheckSquare className="w-4 h-4 text-emerald-400" />
                      <span>すべて解除</span>
                    </>
                  ) : (
                    <>
                      <Square className="w-4 h-4 text-slate-400" />
                      <span>全選択</span>
                    </>
                  )}
                </button>
                <span className="text-slate-400">
                  全 {candidateOrders.length} 件中 <span className="text-amber-300 font-bold">{selectedCandidateIds.size}</span> 件を選択中
                </span>
              </div>
            </div>

            {/* 候補商品一覧テーブル（内部可変スクロール） */}
            <div className="flex-1 min-h-[150px] overflow-y-auto custom-scrollbar border border-slate-800 rounded-xl my-1">
              <table className="w-full text-left text-xs text-slate-200">
                <thead className="bg-slate-800/90 text-slate-300 font-bold sticky top-0 border-b border-slate-700 z-10">
                  <tr>
                    <th className="py-2.5 px-3 text-center w-12">除外</th>
                    <th className="py-2.5 px-3">商品名</th>
                    <th className="py-2.5 px-3">JANコード</th>
                    <th className="py-2.5 px-3">検出理由</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {candidateOrders.map(ord => {
                    const isChecked = selectedCandidateIds.has(ord.id);
                    const lk = shipmentMap.get(ord.id);
                    const isOtcKeyword = /ノルレボ|チェックワン|妊娠|排卵|自費|OTC|一般用|テストキット|検査薬|第[1１2２3３]類/i.test(ord.name);

                    return (
                      <tr 
                        key={ord.id}
                        onClick={() => {
                          const next = new Set(selectedCandidateIds);
                          if (isChecked) next.delete(ord.id);
                          else next.add(ord.id);
                          setSelectedCandidateIds(next);
                        }}
                        className={`cursor-pointer transition-colors ${isChecked ? 'bg-amber-950/20 hover:bg-amber-950/30' : 'hover:bg-slate-800/40 opacity-70'}`}
                      >
                        <td className="py-2.5 px-3 text-center">
                          {isChecked ? (
                            <CheckSquare className="w-4 h-4 text-amber-400 mx-auto" />
                          ) : (
                            <Square className="w-4 h-4 text-slate-500 mx-auto" />
                          )}
                        </td>
                        <td className="py-2.5 px-3 font-bold text-white">
                          {ord.name}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-slate-400">
                          {ord.jan_code}
                        </td>
                        <td className="py-2.5 px-3 text-slate-400">
                          {isOtcKeyword ? (
                            <span className="text-amber-300 font-semibold">一般品・OTC・検査薬キーワード検出</span>
                          ) : lk && lk.kind === 'none' ? (
                            <span className="text-slate-400">厚労省医療用医薬品マスタ非掲載品</span>
                          ) : (
                            <span>除外候補</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* モーダルアクション（常に最下部に固定表示） */}
            <div className="flex justify-between items-center border-t border-slate-800 pt-4 flex-shrink-0 mt-3">
              <button
                onClick={() => setShowCandidateModal(false)}
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs px-5 py-2.5 rounded-xl border border-slate-700"
              >
                キャンセル
              </button>

              <button
                onClick={handleConfirmCandidateExclusion}
                disabled={selectedCandidateIds.size === 0}
                className="bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs px-6 py-2.5 rounded-xl shadow-lg transition-all disabled:opacity-50 flex items-center gap-2"
              >
                <ShieldAlert className="w-4 h-4" />
                <span>選択した {selectedCandidateIds.size} 件を確定して除外マスタに登録</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 除外マスタ設定モーダル */}
      {showIgnoredMasterModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-5 text-slate-200">
            <div className="flex items-start justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-amber-400" />
                <h3 className="text-lg font-black text-white">自動除外対象品目マスタ</h3>
              </div>
              <button 
                onClick={() => setShowIgnoredMasterModal(false)}
                className="text-slate-400 hover:text-white font-bold p-1 rounded-lg"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-400">
              ここに登録されている商品は、次回以降の発注CSVインポート時に自動的に管理対象外としてスキップされます。
            </p>

            <div className="max-h-[350px] overflow-y-auto space-y-2 custom-scrollbar">
              {ignoredItems.length === 0 ? (
                <div className="p-8 text-center text-slate-500 text-xs font-bold">
                  除外マスタに登録されている品目はまだありません。
                </div>
              ) : (
                ignoredItems.map(item => (
                  <div key={item.id} className="flex items-center justify-between bg-slate-800/80 p-3 rounded-xl border border-slate-700/60 text-xs">
                    <div>
                      <div className="font-bold text-white text-sm">{item.name}</div>
                      <div className="text-slate-400 text-[11px] flex gap-3 mt-0.5">
                        {item.jan_code && <span>JAN: {item.jan_code}</span>}
                        <span>理由: {item.reason || '一般品・自費品'}</span>
                      </div>
                    </div>

                    <button
                      onClick={() => handleRemoveFromIgnored(item)}
                      className="px-3 py-1 bg-rose-950/70 hover:bg-rose-900 text-rose-300 text-xs font-bold rounded-lg border border-rose-800/60 transition-colors"
                    >
                      解除（復元）
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="flex justify-end border-t border-slate-800 pt-3">
              <button
                onClick={() => setShowIgnoredMasterModal(false)}
                className="bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs px-5 py-2 rounded-xl border border-slate-700"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 発注詳細モーダル */}
      {selectedOrderForDetail && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-5 text-slate-200">
            <div className="flex items-start justify-between border-b border-slate-800 pb-3">
              <div>
                <span className="text-xs text-emerald-400 font-bold">発注詳細・出荷状況</span>
                <h3 className="text-lg font-black text-white mt-0.5">{selectedOrderForDetail.order.name}</h3>
              </div>
              <button 
                onClick={() => setSelectedOrderForDetail(null)}
                className="text-slate-400 hover:text-white font-bold p-1 rounded-lg"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4 text-xs bg-slate-800/60 p-4 rounded-xl border border-slate-700/50">
              <div>
                <span className="text-slate-400">発注日:</span>
                <div className="font-bold text-white text-sm">{selectedOrderForDetail.order.order_date}</div>
              </div>
              <div>
                <span className="text-slate-400">納品指定日:</span>
                <div className="font-bold text-white text-sm">{selectedOrderForDetail.order.delivery_date}</div>
              </div>
              <div>
                <span className="text-slate-400">納品数量 / 発注数量:</span>
                <div className="font-bold text-emerald-400 text-sm">
                  {selectedOrderForDetail.order.delivered_qty} / {selectedOrderForDetail.order.order_qty}
                </div>
              </div>
              <div>
                <span className="text-slate-400">発注先卸:</span>
                <div className="font-bold text-white text-sm">{selectedOrderForDetail.order.supplier || '-'}</div>
              </div>
              <div>
                <span className="text-slate-400">JANコード:</span>
                <div className="font-mono text-slate-300">{selectedOrderForDetail.order.jan_code}</div>
              </div>
              <div>
                <span className="text-slate-400">取り込み元ファイル:</span>
                <div className="text-slate-300 truncate">{selectedOrderForDetail.order.source_file || '-'}</div>
              </div>
            </div>

            {/* 厚労省 出荷調整詳細 */}
            {selectedOrderForDetail.shipment && selectedOrderForDetail.shipment.rows.length > 0 ? (
              <div className="space-y-3 bg-purple-950/30 border border-purple-800/50 p-4 rounded-xl">
                <div className="flex items-center gap-2 text-purple-300 font-bold text-sm">
                  <AlertCircle className="w-4 h-4 text-purple-400" />
                  <span>厚労省 出荷状況・供給調整データ</span>
                </div>
                {selectedOrderForDetail.shipment.rows.map((row, idx) => (
                  <div key={idx} className="text-xs space-y-1.5 border-t border-purple-800/30 pt-2 first:border-0 first:pt-0">
                    <div className="flex justify-between font-bold text-slate-200">
                      <span>状況: <span className="text-purple-300">{row.status}</span></span>
                      {row.status_date && <span className="text-slate-400">更新: {row.status_date}</span>}
                    </div>
                    {row.reason && <div><span className="text-slate-400">理由:</span> {row.reason}</div>}
                    {row.volume_status && <div><span className="text-slate-400">出荷量状況:</span> {row.volume_status}</div>}
                    {row.outlook && <div><span className="text-slate-400">解消見込み:</span> {row.outlook}</div>}
                    {row.outlook_detail && <div><span className="text-slate-400">詳細:</span> {row.outlook_detail}</div>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-slate-800/40 border border-slate-700/40 p-4 rounded-xl text-xs text-slate-400">
                厚労省の「医療用医薬品の供給状況」リストにおける出荷調整等の該当データはありません（通常出荷想定）。
              </div>
            )}

            <div className="flex justify-between items-center border-t border-slate-800 pt-3">
              <button
                onClick={() => {
                  handleAddToIgnored(selectedOrderForDetail.order);
                  setSelectedOrderForDetail(null);
                }}
                className="flex items-center gap-1.5 bg-amber-950/80 hover:bg-amber-900 text-amber-300 px-4 py-2 rounded-xl text-xs font-bold border border-amber-700/60 transition-colors"
              >
                <ShieldAlert className="w-4 h-4 text-amber-400" />
                <span>次回から自動除外する</span>
              </button>

              <button
                onClick={() => setSelectedOrderForDetail(null)}
                className="bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs px-5 py-2 rounded-xl border border-slate-700"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
