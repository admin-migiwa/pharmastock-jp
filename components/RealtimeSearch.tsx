import React, { useState, useEffect, useCallback } from 'react';
import { Search, Globe, Clock, Building2, RefreshCcw, LayoutGrid, CircleCheckBig, AlertTriangle, Truck } from 'lucide-react';
import { supabase } from '../supabase';
import { Store, RealtimeStock, ShipmentLookup } from '../types';
import { lookupShipment, getShipmentBadge } from '../shipmentMatch';

interface RealtimeSearchProps {
  stores: Store[];
  currentStoreId: string;
}

interface StockDetail {
  purchase_date: string;
  lot_number: string;
  expiry_date: string;
  quantity: number;
}

const getTimeAgo = (dateString: string | null): string => {
  if (!dateString) return '不明';
  const now = new Date();
  const updated = new Date(dateString);
  const diffInSeconds = Math.floor((now.getTime() - updated.getTime()) / 1000);
  if (diffInSeconds < 60) return '今';
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}分前`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}時間前`;
  if (diffInSeconds < 2592000) return `${Math.floor(diffInSeconds / 86400)}日前`;
  return `${Math.floor(diffInSeconds / 2592000)}ヶ月前`;
};

const normalizeQuery = (str: string): string => {
  return str
    .replace(/[ぁ-ん]/g, (s) => String.fromCharCode(s.charCodeAt(0) + 0x60))
    .replace(/[ァ-ン]/g, (s) => {
      const map: { [key: string]: string } = {
        'ア': 'ｱ', 'イ': 'ｲ', 'ウ': 'ｳ', 'エ': 'ｴ', 'オ': 'ｵ',
        'カ': 'ｶ', 'キ': 'ｷ', 'ク': 'ｸ', 'ケ': 'ｹ', 'コ': 'ｺ',
        'サ': 'ｻ', 'シ': 'ｼ', 'ス': 'ｽ', 'セ': 'ｾ', 'ソ': 'ｿ',
        'タ': 'ﾀ', 'チ': 'ﾁ', 'ツ': 'ﾂ', 'テ': 'ﾃ', 'ト': 'ﾄ',
        'ナ': 'ﾅ', 'ニ': 'ﾆ', 'ヌ': 'ﾇ', 'ネ': 'ﾈ', 'ノ': 'ﾉ',
        'ハ': 'ﾊ', 'ヒ': 'ﾋ', 'フ': 'ﾌ', 'ヘ': 'ﾍ', 'ホ': 'ﾎ',
        'マ': 'ﾏ', 'ミ': 'ﾐ', 'ム': 'ﾑ', 'メ': 'ﾒ', 'モ': 'ﾓ',
        'ヤ': 'ﾔ', 'ユ': 'ﾕ', 'ヨ': 'ﾖ',
        'ラ': 'ﾗ', 'リ': 'ﾘ', 'ル': 'ﾙ', 'レ': 'ﾚ', 'ロ': 'ﾛ',
        'ワ': 'ﾜ', 'ヲ': 'ｦ', 'ン': 'ﾝ', 'ガ': 'ｶﾞ', 'ギ': 'ｷﾞ',
        'ー': 'ｰ', ' ': ' ', '　': ' '
      };
      return map[s] || s;
    });
};

const getExpiryStatus = (dateString: string | null) => {
  if (!dateString || dateString === '9999-12-31' || dateString === '') {
    return { text: '-', class: 'text-slate-400' };
  }
  const normalizedDate = dateString.replace(/\./g, '-');
  const expiry = new Date(normalizedDate);
  if (isNaN(expiry.getTime())) {
    return { text: dateString, class: 'text-slate-600' };
  }
  const now = new Date();
  const threeMonthsLater = new Date();
  threeMonthsLater.setMonth(now.getMonth() + 3);
  if (expiry < now) return { text: dateString, class: 'text-red-600 font-black' };
  if (expiry < threeMonthsLater) return { text: dateString, class: 'text-amber-600 font-black' };
  return { text: dateString, class: 'text-slate-600' };
};

// 出荷状況バッジ（一覧用）
const ShipmentBadge: React.FC<{ lookup?: ShipmentLookup }> = ({ lookup }) => {
  if (!lookup || lookup.kind === 'none') {
    return <span className="text-[10px] text-slate-300 font-bold">情報なし</span>;
  }
  if (lookup.kind === 'ambiguous') {
    return <span className="text-[10px] font-black px-2 py-0.5 rounded-md bg-amber-50 text-amber-600 border border-amber-200">要確認</span>;
  }
  const badge = getShipmentBadge(lookup.rows);
  const mark = lookup.kind !== 'code'
    ? <span className="text-[8px] text-slate-400 font-bold">名称照合</span>
    : null;
  if (!badge) {
    return (
      <div className="flex flex-col items-center gap-0.5">
        <span className="text-[10px] text-slate-400 font-bold">通常</span>
        {mark}
      </div>
    );
  }
  const cls =
    badge.level === 'stop' ? 'bg-red-50 text-red-600 border-red-200' :
    badge.level === 'limited' ? 'bg-amber-50 text-amber-700 border-amber-200' :
    'bg-orange-50 text-orange-600 border-orange-200';
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className={`text-[10px] font-black px-2 py-0.5 rounded-md border whitespace-nowrap ${cls}`}>{badge.label}</span>
      {mark}
    </div>
  );
};

// 出荷状況の詳細（行展開用）
const ShipmentDetail: React.FC<{ lookup?: ShipmentLookup }> = ({ lookup }) => {
  const via = lookup?.kind === 'code' ? 'YJコード一致' : lookup?.kind === 'name' ? '名称照合' : lookup?.kind === 'dict' ? '他店辞書で補完' : '';
  return (
    <div className="space-y-3 mb-6">
      <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
        <Truck size={12} /> 出荷状況（厚労省 供給状況）{via && <span className="text-slate-300 normal-case">／{via}</span>}
      </h4>
      {!lookup || lookup.kind === 'none' ? (
        <div className="text-xs text-slate-400 italic">厚労省の供給状況一覧に該当する情報がありません。</div>
      ) : (
        <>
          {lookup.kind === 'ambiguous' && (
            <div className="text-xs text-amber-600 font-bold flex items-center gap-1">
              <AlertTriangle size={12} /> 名称が一致する候補が複数あります。規格・包装を確認してください。
            </div>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {lookup.rows.map(r => {
              const b = getShipmentBadge([r]);
              const rowCls = b ? (b.level === 'stop' ? 'border-red-200' : b.level === 'limited' ? 'border-amber-200' : 'border-orange-200') : 'border-slate-200';
              const items: [string, string | null | undefined][] = [
                ['出荷対応', r.status],
                ['出荷量', r.volume_status],
                ['理由', r.reason],
                ['解除・解消見込み', r.outlook],
                ['見込み時期', r.outlook_detail],
                ['出荷量改善見込み', [r.volume_outlook, r.volume_amount].filter(Boolean).join(' / ')],
                ['出荷対応の更新日', r.status_date],
                ['その他情報の更新日', r.info_date],
              ];
              return (
                <div key={r.yj_code} className={`bg-white p-3 rounded-xl border shadow-sm ${rowCls}`}>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0">
                      <div className="text-xs font-black text-slate-800 truncate">{r.name}</div>
                      <div className="text-[9px] text-slate-400 font-mono">{r.yj_code}{r.maker ? ` / ${r.maker}` : ''}</div>
                    </div>
                    {r.is_new && <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-blue-600 text-white flex-shrink-0">New</span>}
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
                    {items.filter(([, v]) => v).map(([k, v]) => (
                      <React.Fragment key={k}>
                        <dt className="text-slate-400 font-bold whitespace-nowrap">{k}</dt>
                        <dd className="text-slate-700 font-bold break-words">{v}</dd>
                      </React.Fragment>
                    ))}
                  </dl>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};

const RealtimeSearch: React.FC<RealtimeSearchProps> = ({ stores, currentStoreId }) => {
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [targetStoreId, setTargetStoreId] = useState<string>('');
  const [isAllStores, setIsAllStores] = useState<boolean>(true);
  const [searchResults, setSearchResults] = useState<{ store: Store; stock: RealtimeStock; shipment?: ShipmentLookup }[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [expandedMobileId, setExpandedMobileId] = useState<string | null>(null);
  const [selectedDetailId, setSelectedDetailId] = useState<string | null>(null);
  const [details, setDetails] = useState<{ [key: string]: StockDetail[] }>({});
  const [isDetailLoading, setIsDetailLoading] = useState<boolean>(false);
  const [onlyAdjusting, setOnlyAdjusting] = useState<boolean>(false);

  const fetchStockDetail = async (stock: any) => {
  const uniqueId = `${stock.store_id}-${stock.id}`;
  
  // 展開/折りたたみ制御
  if (selectedDetailId === uniqueId) {
    setSelectedDetailId(null);
    return;
  }

  setSelectedDetailId(uniqueId);

  // キャッシュがあれば再フェッチしない
  if (details[uniqueId]) return;

  setIsDetailLoading(true);
 try {
      // 1. DBへの問い合わせではなく、取得済みのデータを参照
      const rawDetails = stock.expiry_details;

      if (!rawDetails || !Array.isArray(rawDetails)) {
        setDetails(prev => ({ ...prev, [uniqueId]: [] }));
        return;
      }

      // 2. 納品日の新しい順（降順）にソート
      const sorted = [...rawDetails].sort((a, b) => {
        const dateA = new Date(a.purchase_date || 0).getTime();
        const dateB = new Date(b.purchase_date || 0).getTime();
        return dateB - dateA;
      });

      // 3. 在庫数（stock_qty）に達するまでロットを積み上げる
      let currentSum = 0;
      const targetQty = Number(stock.stock_qty || 0);
      const calculatedDetails: StockDetail[] = [];

      for (const item of sorted) {
        if (currentSum >= targetQty) break;

        const itemQty = Number(item.qty || 0);
        const lotNo = item.lot || '不明';
        const expDate = item.expiry || '不明';
        const pDate = item.purchase_date || '不明';

        const neededQty = targetQty - currentSum;

        if (itemQty <= neededQty) {
          // ロット丸ごと追加
          calculatedDetails.push({
            purchase_date: pDate,
            lot_number: lotNo,
            expiry_date: expDate,
            quantity: itemQty
          });
          currentSum += itemQty;
        } else {
          // 在庫数で打ち切るため、最後のロットは端数を計算して表示
          calculatedDetails.push({
            purchase_date: pDate,
            lot_number: lotNo,
            expiry_date: expDate,
            quantity: neededQty
          });
          currentSum += neededQty;
        }
      }

      setDetails(prev => ({ ...prev, [uniqueId]: calculatedDetails }));
    } catch (err) {
      console.error('詳細計算エラー:', err);
      setDetails(prev => ({ ...prev, [uniqueId]: [] }));
    } finally {
      setIsDetailLoading(false);
    }
  };

const performSearch = useCallback(async (query: string, storeId: string, all: boolean) => {
    const trimmedQuery = query.trim();
    
    // ガード句
    if (all) {
      if (trimmedQuery.length < 2) {
        setSearchResults([]);
        return;
      }
    } else {
      if (!storeId) {
        setSearchResults([]);
        return;
      }
      // 個別店舗では2文字制限を適用（DB負荷軽減のため）
      if (trimmedQuery !== '' && trimmedQuery.length < 2) {
        setSearchResults([]);
        return;
      }
    }

    setError('');
    setIsLoading(true);

    try {
      // STEP 1: 在庫データの基本検索
      let dbQuery = supabase
        .from('realtime_stocks') 
        .select('id, store_id, name, spec, stock_qty, unit, expiry_date, expiry_details, yakka_code, updated_at, stock_updated_at');

      if (!all && storeId) dbQuery = dbQuery.eq('store_id', storeId);

      // 検索フィルタ（前方一致）
      if (trimmedQuery !== '') {
        const normalized = normalizeQuery(trimmedQuery);
        const zenkaku = trimmedQuery.replace(/[ぁ-ん]/g, (s) => String.fromCharCode(s.charCodeAt(0) + 0x60));
        dbQuery = dbQuery.or(`name.ilike.${trimmedQuery}%,name.ilike.${normalized}%,name.ilike.${zenkaku}%,yakka_code.eq.${trimmedQuery}`);
      }

      const { data: stocks, error: stockError } = await dbQuery.limit(50);
      if (stockError) throw stockError;

      if (!stocks || stocks.length === 0) {
        setSearchResults([]);
        return;
      }

      // STEP 2: 追っかけフェッチ
      const yakkaCodes = stocks.map(s => s.yakka_code).filter(Boolean);
      const names = stocks.map(s => s.name);

      const { data: purchaseData } = await supabase
        .from('purchase_history')
        .select('store_id, yakka_code, name, updated_at')
        .or(`yakka_code.in.(${yakkaCodes.join(',')}),name.in.("${names.join('","')}")`)
        .order('updated_at', { ascending: false });

      // 出荷状況の突合（YJコード→正規化名称→他店辞書。失敗しても検索結果は表示する）
      const lookups = await lookupShipment(stocks.map(s => ({ name: s.name, yakka_code: s.yakka_code })));

      // STEP 3: マージ処理
      const results = stocks.map((stock, idx) => {
        const store = stores.find((s) => s.id === stock.store_id) || { id: stock.store_id, name: '不明' };
        
        // 突合：薬価コード優先、次いで名称一致
        const match = purchaseData?.find(p => {
          if (p.store_id !== stock.store_id) return false;
          if (stock.yakka_code && p.yakka_code === stock.yakka_code) return true;
          return normalizeQuery(p.name) === normalizeQuery(stock.name);
        });

        return {
          store,
          stock: {
            ...stock,
            last_purchase_updated_at: match ? match.updated_at : null
          } as RealtimeStock,
          shipment: lookups[idx],
        };
      });

      // 4. ソートロジック
      const sortedResults = [...results].sort((a, b) => {
        // A. クエリが空の場合（五十音順 + 自店優先）
        if (trimmedQuery === '') {
          const nameComp = a.stock.name.localeCompare(b.stock.name, 'ja', { numeric: true, sensitivity: 'base' });
          if (nameComp !== 0) return nameComp;
          if (a.store.id !== b.store.id) {
            if (a.store.id === currentStoreId) return -1;
            if (b.store.id === currentStoreId) return 1;
          }
          return 0;
        }

        // B. 検索クエリがある場合
        const normQuery = normalizeQuery(trimmedQuery).toLowerCase();
        const nameA = a.stock.name.toLowerCase();
        const nameB = b.stock.name.toLowerCase();
        const normA = normalizeQuery(nameA);
        const normB = normalizeQuery(nameB);

        // 先頭一致（Prefix Match）優先
        const isStartA = nameA.startsWith(trimmedQuery.toLowerCase()) || normA.startsWith(normQuery);
        const isStartB = nameB.startsWith(trimmedQuery.toLowerCase()) || normB.startsWith(normQuery);
        if (isStartA !== isStartB) return isStartA ? -1 : 1;

        // 五十音順
        const nameComparison = a.stock.name.localeCompare(b.stock.name, 'ja', {
          numeric: true,
          sensitivity: 'base'
        });
        if (nameComparison !== 0) return nameComparison;

        // 自店優先
        if (a.store.id !== b.store.id) {
          if (a.store.id === currentStoreId) return -1;
          if (b.store.id === currentStoreId) return 1;
        }

        // 更新日時順
        const dateA = new Date(a.stock.updated_at || 0).getTime();
        const dateB = new Date(b.stock.updated_at || 0).getTime();
        return dateB - dateA;
      });

      setSearchResults(sortedResults);
    } catch (err) {
      console.error('検索エラー:', err);
      setError('サーバー負荷が高まっています。条件を絞って再度お試しください。');
    } finally {
      setIsLoading(false);
    }
  }, [stores, currentStoreId]);

  useEffect(() => {
    const timer = setTimeout(() => {
      performSearch(searchQuery, targetStoreId, isAllStores);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, targetStoreId, isAllStores, performSearch]);

  // 「出荷調整中のみ」絞り込み（要確認は見落とし防止のため表示し続ける）
  const displayResults = onlyAdjusting
    ? searchResults.filter(r => r.shipment && (r.shipment.kind === 'ambiguous' || getShipmentBadge(r.shipment.rows)))
    : searchResults;

  return (
    <div className="w-full max-w-7xl mx-auto p-4 space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black text-slate-900 flex items-center gap-3">
            <Globe className="w-8 h-8 text-blue-600" />
            リアルタイム在庫検索
          </h1>
          <p className="text-slate-500 font-bold mt-1">
            店舗を指定して、現在の薬品在庫状況を確認します
          </p>
        </div>
      </div>

      <div className="bg-white p-4 md:p-6 rounded-[24px] md:rounded-[32px] border-2 border-slate-100 shadow-sm space-y-4 md:space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end">
          <div className="lg:col-span-5 space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase ml-1 tracking-widest flex items-center gap-2">
              <Building2 size={12} /> 検索対象の範囲
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setIsAllStores(!isAllStores)}
                className={`px-4 py-3 rounded-2xl font-black text-xs transition-all flex items-center gap-2 whitespace-nowrap border-2 ${
                  isAllStores 
                    ? 'bg-blue-600 border-blue-600 text-white shadow-md shadow-blue-100' 
                    : 'bg-slate-50 border-transparent text-slate-400'
                }`}
              >
                {isAllStores ? <CircleCheckBig size={14} /> : <div className="w-3.5 h-3.5 rounded-full border-2 border-slate-300" />}
                全店
              </button>
              <select
                value={targetStoreId}
                onChange={(e) => {
                  setTargetStoreId(e.target.value);
                  setIsAllStores(false);
                }}
                className={`flex-1 px-4 py-3 bg-slate-50 border-2 rounded-2xl font-bold text-sm text-slate-700 outline-none transition-all ${
                  isAllStores ? 'border-transparent opacity-40 cursor-not-allowed' : 'border-slate-100 focus:border-blue-500'
                }`}
                disabled={isAllStores}
              >
                <option value="">個別店舗を選択...</option>
                {stores.map(store => (
                  <option key={store.id} value={store.id}>
                    {store.name} {store.id === currentStoreId ? '(自店)' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="lg:col-span-7 space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase ml-1 tracking-widest flex items-center gap-2">
              <Search size={12} /> 薬品検索
            </label>
            <input
              type="text"
              placeholder={
              isAllStores 
                    ? "全店検索（2文字以上入力）..." 
                    : targetStoreId 
                      ? "薬品名で絞り込み（2文字以上）..." 
                      : "まず店舗を選択してください"
                }
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-4 pr-4 py-3 bg-slate-50 border-2 border-transparent focus:border-blue-500 rounded-2xl font-bold text-sm md:text-base text-slate-700 outline-none transition-all shadow-inner"
            />
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer w-fit select-none">
          <input
            type="checkbox"
            checked={onlyAdjusting}
            onChange={(e) => setOnlyAdjusting(e.target.checked)}
            className="w-4 h-4 accent-amber-500"
          />
          <span className="text-xs font-black text-slate-600 flex items-center gap-1">
            <AlertTriangle size={12} className="text-amber-500" /> 出荷調整中のみ表示
          </span>
        </label>
      </div>

      {error && <div className="p-4 bg-red-50 text-red-700 rounded-xl border border-red-200 font-bold">{error}</div>}

      {isLoading ? (
        <div className="text-center py-20 bg-white rounded-[32px] border border-slate-100 shadow-sm">
          <RefreshCcw className="w-12 h-12 text-blue-600 animate-spin mx-auto" />
          <p className="text-slate-400 font-black mt-4 uppercase tracking-widest text-sm font-mono">Searching Database...</p>
        </div>
      ) : displayResults.length > 0 ? (
        <div className="bg-white rounded-[24px] md:rounded-[32px] shadow-xl shadow-slate-200/50 border border-slate-100 overflow-hidden">
          
          {/* デスクトップ表示 */}
          <div className="hidden md:block">
            <table className="w-full text-left border-collapse table-fixed">
              <thead>
              <tr className="bg-slate-50/50 border-b border-slate-100">
                <th className="w-[16%] px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">店舗</th>
                <th className="w-[30%] px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">薬品名</th>
                <th className="w-[13%] px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">在庫数</th>
                <th className="w-[8%] px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">単位</th>
                <th className="w-[17%] px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">出荷状況</th>
                <th className="w-[16%] px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">使用期限</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-bold">
                {displayResults.map((result) => {
                  const expiry = getExpiryStatus(result.stock.expiry_date);
                  const uniqueId = `${result.stock.store_id}-${result.stock.id}`;
                return (
                  <React.Fragment key={uniqueId}>
                    {/* メインの行 */}
                    <tr 
                      onClick={() => fetchStockDetail(result.stock)}
                      className={`cursor-pointer transition-colors ${
                        selectedDetailId === uniqueId ? 'bg-blue-100/50' : 
                        result.store.id === currentStoreId ? 'bg-blue-50/30' : 'hover:bg-slate-50/50'
                      }`}
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <Building2 size={14} className={result.store.id === currentStoreId ? 'text-blue-500' : 'text-slate-400'} />
                          <span className={`truncate text-sm ${result.store.id === currentStoreId ? 'text-blue-700 font-black' : 'text-slate-600'}`}>
                            {result.store.name}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4 relative group" title={result.stock.name}>
                        <div className="text-sm text-slate-800 line-clamp-1 group-hover:text-blue-600 transition-colors">
                          {result.stock.name}
                        </div>
                        <div className="text-[9px] text-slate-400 font-mono tracking-tighter">
                          {result.stock.yakka_code}
                        </div>
                      </td>

                      <td className="px-6 py-4 text-right">
                        <div className="flex flex-col items-end">
                          <span className="text-xl font-black text-blue-600 tabular-nums">
                            {result.stock.stock_qty.toLocaleString()}
                          </span>
                          <span className="text-[8px] text-slate-400 font-medium whitespace-nowrap">
                            更新: {getTimeAgo(result.stock.stock_updated_at)}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <span className="text-xs text-slate-500 font-bold">{result.stock.unit}</span>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <ShipmentBadge lookup={result.shipment} />
                      </td>
                      <td className="px-6 py-4 text-center border-l border-slate-50">
                        <div className="flex flex-col items-center">
                          <div className={`text-xs font-mono font-bold ${expiry.class}`}>
                            {expiry.text}
                          </div>
                        </div>
                      </td>
                    </tr>

                      {selectedDetailId === uniqueId && (
                    <tr className="bg-slate-50/80 border-l-4 border-l-blue-500">
                      <td colSpan={6} className="px-8 py-6">
                        <ShipmentDetail lookup={result.shipment} />
                        <div className="space-y-3">
                          <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                            <LayoutGrid size={12} /> 直近の入庫履歴内訳
                          </h4>
                          
                          {isDetailLoading ? (
                            <div className="flex items-center gap-2 text-slate-400 text-xs font-bold py-4">
                              <RefreshCcw size={14} className="animate-spin" /> 履歴データを照合中...
                            </div>
                          ) : details[uniqueId]?.length > 0 ? (
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                              {details[uniqueId].map((d, i) => (
                                <div key={i} className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
                                  <div className="text-[9px] text-slate-400 font-mono mb-1">{d.purchase_date} 入庫</div>
                                  <div className="flex justify-between items-center">
                                    <span className="text-[10px] font-black text-slate-700">Lot: {d.lot_number}</span>
                                    <span className="text-sm font-black text-blue-600">{d.quantity}{result.stock.unit}</span>
                                  </div>
                                  <div className={`text-[9px] font-bold mt-1 ${getExpiryStatus(d.expiry_date).class}`}>
                                    期限: {d.expiry_date || '不明'}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="text-xs text-slate-400 italic py-4">該当する詳細な入庫履歴は見つかりませんでした。</div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
          </table>
          </div>

          {/* モバイル表示 */}
          <div className="md:hidden divide-y divide-slate-100">
            {displayResults.map((result) => {
              const expiry = getExpiryStatus(result.stock.expiry_date);
              const uniqueId = `${result.stock.store_id}-${result.stock.id}`;
              const isExpanded = expandedMobileId === uniqueId;
              return (
                <div 
                  key={uniqueId}
                  className={`p-4 flex flex-col gap-2 ${result.store.id === currentStoreId ? 'bg-blue-50/40' : ''}`}
                >
                  <div className="flex justify-between items-start">
                    <div className="flex items-center gap-2">
                      <Building2 size={12} className={result.store.id === currentStoreId ? 'text-blue-500' : 'text-slate-400'} />
                      <span className="text-[10px] font-black text-slate-500">{result.store.name}</span>
                    </div>
                    <div className="flex flex-col items-end">
                      <div className={`text-[10px] font-mono font-black px-2 py-0.5 rounded-md bg-slate-100 ${expiry.class}`}>
                        EXP: {expiry.text}
                      </div>
                      <div className="text-[7px] text-slate-300 font-medium mt-0.5">
                        同期: {getTimeAgo(result.stock.updated_at)}
                      </div>
                    </div>
                  </div>

                  <div 
                    onClick={() => setExpandedMobileId(isExpanded ? null : uniqueId)}
                    className={`font-bold text-slate-800 text-sm transition-all duration-200 cursor-pointer ${isExpanded ? 'whitespace-normal' : 'line-clamp-1'}`}
                  >
                    {result.stock.name}
                  </div>

                <div className="flex items-center gap-2 mt-1">
                  <ShipmentBadge lookup={result.shipment} />
                </div>
                <div className="flex justify-between items-end mt-1">
                  <div className="text-[8px] text-slate-400">
                    {result.stock.yakka_code}<br/>
                    更新: {getTimeAgo(result.stock.stock_updated_at)}
                  </div>
                  {/* 在庫数と単位を並べる */}
                  <div className="flex items-baseline gap-1">
                    <span className="text-2xl font-black text-blue-600">
                      {result.stock.stock_qty.toLocaleString()}
                    </span>
                    <span className="text-xs font-bold text-slate-400">{result.stock.unit}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        </div>
      ) : (
        <div className="text-center py-20 bg-slate-50/50 rounded-[32px] border-4 border-dashed border-slate-100">
          <Building2 className="w-12 h-12 text-slate-200 mx-auto mb-4" />
          <p className="text-slate-400 font-black text-sm px-6">
            {!isAllStores && !targetStoreId 
              ? "店舗を選択するか、全店検索をオンにしてください" 
              : onlyAdjusting && searchResults.length > 0
                ? "検索結果の中に出荷調整中の品目はありません"
                : "該当する在庫データが見つかりませんでした"}
          </p>
        </div>
      )}
    </div>
  );
};

export default RealtimeSearch;