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
  Check
} from 'lucide-react';
import { Store, Order, OrderStatus } from '../types';
import { supabase } from '../supabase';
import { parseOrderCsv, reconcileOrders, getDelayBadge, DelayBadgeInfo } from '../orderMatch';
import { lookupShipment, getShipmentBadge } from '../shipmentMatch';
import { ShipmentLookup } from '../types';

interface OrderManagementProps {
  stores: Store[];
  currentStoreId: string;
}

export const OrderManagement: React.FC<OrderManagementProps> = ({ stores, currentStoreId }) => {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [marginDays, setMarginDays] = useState<number>(7);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'unfulfilled' | 'pending' | 'delayed' | 'partial' | 'fulfilled'>('all');
  const [adjustingFilter, setAdjustingFilter] = useState<boolean>(false);
  const [shipmentMap, setShipmentMap] = useState<Map<string, ShipmentLookup>>(new Map());
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 20;
  const [uploadMessage, setUploadMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [selectedOrderForDetail, setSelectedOrderForDetail] = useState<{ order: Order; shipment?: ShipmentLookup } | null>(null);

  const currentStore = stores.find(s => s.id === currentStoreId);

  // データ取得
  const fetchOrders = async () => {
    if (!currentStoreId) return;
    setLoading(true);
    try {
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

    // 既存の発注データを取得して重複・消し込み済みステータスを退避
    const { data: existingDbOrders } = await supabase
      .from('orders')
      .select('*')
      .eq('store_id', currentStoreId);

    const existingMap = new Map<string, Order>();
    (existingDbOrders as Order[] || []).forEach(o => {
      const key = `${o.store_id}_${o.order_date}_${o.jan_code}_${o.order_qty}`;
      existingMap.set(key, o);
    });

    let totalImported = 0;
    let skippedCount = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const text = await readFileWithEncoding(file);
        const parsedRows = parseOrderCsv(text);

        if (parsedRows.length === 0) continue;

        const updates: Partial<Order>[] = [];
        const inserts: Omit<Order, 'id'>[] = [];

        parsedRows.forEach(r => {
          const key = `${currentStoreId}_${r.order_date}_${r.jan_code}_${r.order_qty}`;
          const existing = existingMap.get(key);

          if (existing) {
            // 既存データがある場合はIDを指定して更新（完了状態などは維持）
            if (existing.status === 'fulfilled' || existing.status === 'partial') {
              skippedCount++;
            }
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
              status: existing.status,
              source_file: file.name,
              updated_at: new Date().toISOString()
            });
          } else {
            // 新規データは id プロパティを含めずに insert 用配列へ追加 (Supabase側でgen_random_uuid生成)
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
              status: 'pending' as OrderStatus,
              source_file: file.name,
              updated_at: new Date().toISOString()
            });
          }
        });

        // 既存データの更新実行
        if (updates.length > 0) {
          const { error: updateErr } = await supabase.from('orders').upsert(updates);
          if (updateErr) {
            console.error('Error updating existing orders:', updateErr);
            throw new Error(`既存データの更新失敗: ${updateErr.message}`);
          }
        }

        // 新規データの挿入実行
        if (inserts.length > 0) {
          const { error: insertErr } = await supabase.from('orders').insert(inserts);
          if (insertErr) {
            console.error('Error inserting new orders:', insertErr);
            throw new Error(`新規データの登録失敗: ${insertErr.message}`);
          }
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
      setUploadMessage({ type: 'success', text: `${totalImported} 件の発注データをインポートしました。照合を実行中...` });
      // 自動照合
      try {
        const result = await reconcileOrders(currentStoreId, marginDays);
        setUploadMessage({ type: 'success', text: `${totalImported} 件をインポートし、${result.updatedCount} 件の消し込みを行いました。` });
      } catch (rErr) {
        console.error('Auto reconcile error:', rErr);
      }
      await fetchOrders();
    }
    setLoading(false);
    event.target.value = '';
  };

  // 文字エンコーディング判定付きファイル読み込み
  const readFileWithEncoding = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const buffer = e.target?.result as ArrayBuffer;
        // Shift_JIS (CP932) でまずデコード
        const sjisDecoder = new TextDecoder('shift-jis');
        const sjisText = sjisDecoder.decode(buffer);

        // ヘッダーや主要キーワード（発注、品名、商品コード、数量等）が解読できていれば Shift_JIS と判定
        if (/発注|品名|商品コード|発注数量|納品/.test(sjisText) && !sjisText.includes('\uFFFD')) {
          resolve(sjisText);
          return;
        }

        // そうでなければ UTF-8 で試行
        const utf8Decoder = new TextDecoder('utf-8');
        const utf8Text = utf8Decoder.decode(buffer);
        if (/発注|品名|商品コード|発注数量|納品/.test(utf8Text)) {
          resolve(utf8Text);
          return;
        }

        // キーワードが見つからない場合はデフォルトで Shift_JIS の解読結果を採用
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

  // 個別ステータス更新
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
      // 検索ワード
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchName = ord.name.toLowerCase().includes(q);
        const matchJan = ord.jan_code.includes(q);
        const matchMaker = (ord.maker || '').toLowerCase().includes(q);
        const matchSupplier = (ord.supplier || '').toLowerCase().includes(q);
        if (!matchName && !matchJan && !matchMaker && !matchSupplier) return false;
      }

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
  }, [orders, searchQuery, statusFilter, adjustingFilter, shipmentMap]);

  // サマリー計算
  const stats = useMemo(() => {
    const total = orders.length;
    const pending = orders.filter(o => o.status === 'pending').length;
    const delayed = orders.filter(o => o.status === 'delayed').length;
    const partial = orders.filter(o => o.status === 'partial').length;
    const fulfilled = orders.filter(o => o.status === 'fulfilled').length;
    const unfulfilledCount = pending + delayed + partial;

    let adjustingCount = 0;
    orders.forEach(o => {
      const lk = shipmentMap.get(o.id);
      if (lk && getShipmentBadge(lk.rows)) adjustingCount++;
    });

    return { total, unfulfilledCount, pending, delayed, partial, fulfilled, adjustingCount };
  }, [orders, shipmentMap]);

  // ページネーション
  const totalPages = Math.ceil(filteredOrders.length / itemsPerPage) || 1;
  const paginatedOrders = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredOrders.slice(start, start + itemsPerPage);
  }, [filteredOrders, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, statusFilter, adjustingFilter]);

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
            発注CSVデータを入庫履歴と照合し、未納品・納期ズレ・出荷調整品目を可視化します
          </p>
        </div>

        {/* ファイルインポート & 照合実行ボタン */}
        <div className="flex flex-wrap items-center gap-3">
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
              <option value={7}>指定日+7日 (推移可視化)</option>
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
          <div className="text-xs font-bold text-slate-400">全発注件数</div>
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
      <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-2xl shadow-lg space-y-3">
        <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
          {/* 検索入力 */}
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="品名・JANコード・メーカー・発注先卸名で検索..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 text-white placeholder-slate-400 pl-9 pr-4 py-2 rounded-xl text-sm focus:outline-none focus:border-emerald-500 font-medium"
            />
          </div>

          {/* フィルタボタン群 */}
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
                未完納のみ ({stats.unfulfilledCount})
              </button>
              <button
                onClick={() => setStatusFilter('partial')}
                className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${
                  statusFilter === 'partial' ? 'bg-amber-600 text-white shadow' : 'text-slate-400 hover:text-white'
                }`}
              >
                分納
              </button>
              <button
                onClick={() => setStatusFilter('fulfilled')}
                className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${
                  statusFilter === 'fulfilled' ? 'bg-emerald-600 text-white shadow' : 'text-slate-400 hover:text-white'
                }`}
              >
                完納
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
            該当する発注データが見つかりません。発注CSVファイルをインポートしてください。
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
                    <th className="py-3 px-4 text-center">発注 / 納入</th>
                    <th className="py-3 px-4">納品状態 & 遅延ラグ</th>
                    <th className="py-3 px-4">厚労省 出荷調整状況</th>
                    <th className="py-3 px-4 text-center">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-medium">
                  {paginatedOrders.map((ord) => {
                    const delayBadge = getDelayBadge(ord);
                    const shipmentLk = shipmentMap.get(ord.id);
                    const shipmentBadge = shipmentLk ? getShipmentBadge(shipmentLk.rows) : null;

                    return (
                      <tr 
                        key={ord.id}
                        className="hover:bg-slate-800/40 transition-colors"
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
                          <div 
                            className="font-bold text-emerald-400 hover:underline cursor-pointer text-sm"
                            onClick={() => setSelectedOrderForDetail({ order: ord, shipment: shipmentLk })}
                          >
                            {ord.name}
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
                          <div className="flex flex-col gap-1 items-start">
                            {/* ラグバッジ */}
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

                        {/* 操作 */}
                        <td className="py-3.5 px-4 text-center whitespace-nowrap">
                          <div className="flex items-center justify-center gap-1.5">
                            {ord.status !== 'fulfilled' && (
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
                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-xs font-bold text-slate-300 px-2">
                  {currentPage} / {totalPages}
                </span>
                <button
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* 詳細モーダル */}
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
                <span className="text-slate-400">発注数量 / 納品数量:</span>
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

            <div className="flex justify-end">
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
