import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  FileSpreadsheet, Upload, CheckCircle, AlertCircle, Info, Building2,
  FileWarning, RefreshCw, BarChart3, AlertTriangle, Truck, ChevronLeft, ChevronRight,
  ChevronDown, ChevronUp, Package
} from 'lucide-react';
import readXlsxFile from 'read-excel-file/browser';
import { supabase } from '../supabase';
import { Store, RealtimeStock, ShipmentLookup } from '../types';
import { normalizeName, isValidYjCode, lookupShipment, getShipmentBadge } from '../shipmentMatch';

interface ShipmentStatusImportProps {
  storeId: string;
  stores: Store[];
}

interface ParsedRow {
  yj_code: string;
  name: string;
  name_key: string;
  maker: string | null;
  status: string;
  status_date: string | null;
  reason: string | null;
  outlook: string | null;
  outlook_detail: string | null;
  volume_status: string | null;
  volume_outlook: string | null;
  volume_amount: string | null;
  info_date: string | null;
  is_new: boolean;
  is_adjusting: boolean;
}

interface StoreReport {
  storeName: string;
  total: number;
  code: number;
  name: number;
  dict: number;
  ambiguous: number;
  none: number;
}

const toStr = (v: any): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).replace(/\r?\n/g, ' ').trim();
};
const toDateStr = (v: any): string | null => {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = toStr(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};
const orNull = (v: any): string | null => {
  const s = toStr(v);
  return s === '' ? null : s;
};

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

const parseWorkbook = async (file: File): Promise<ParsedRow[]> => {
  const sheets: any = await readXlsxFile(file);
  const data: any[][] = Array.isArray(sheets) && sheets[0]?.data ? sheets[0].data : sheets;

  // ヘッダー行（「YJコード」を含む行）を探す
  let headerIdx = -1;
  for (let i = 0; i < Math.min(data.length, 15); i++) {
    if ((data[i] || []).some(c => toStr(c).includes('YJコード'))) { headerIdx = i; break; }
  }
  if (headerIdx === -1) throw new Error('ヘッダー行（YJコード）が見つかりません。厚労省「医療用医薬品の供給状況」のExcelか確認してください。');

  const headers = (data[headerIdx] || []).map(toStr);
  // ①〜⑳の丸数字で列を特定（列順が変わっても、丸数字が維持されていれば追従できる）
  const col = (circled: string) => headers.findIndex(h => h.startsWith(circled));
  const idx = {
    yj: col('⑤'), name: col('⑥'), maker: col('⑦'), status: col('⑫'), statusDate: col('⑬'),
    reason: col('⑭'), outlook: col('⑮'), outlookDetail: col('⑯'), volume: col('⑰'),
    volumeOutlook: col('⑱'), volumeAmount: col('⑲'), infoDate: col('⑳'),
    isNew: headers.findIndex(h => h.includes('今回掲載時')),
  };
  const missing = (['yj', 'name', 'status'] as const).filter(k => idx[k] === -1);
  if (missing.length > 0) {
    throw new Error('必須列（⑤YJコード／⑥品名／⑫出荷対応の状況）が見つかりません。ファイル形式が変更された可能性があります。');
  }

  const map = new Map<string, ParsedRow>();
  for (let i = headerIdx + 1; i < data.length; i++) {
    const r = data[i] || [];
    const yj = toStr(r[idx.yj]);
    const status = toStr(r[idx.status]);
    if (!yj || !status) continue;
    const volume = idx.volume !== -1 ? orNull(r[idx.volume]) : null;
    const name = toStr(r[idx.name]);
    map.set(yj, {
      yj_code: yj,
      name,
      name_key: normalizeName(name),
      maker: idx.maker !== -1 ? orNull(r[idx.maker]) : null,
      status,
      status_date: idx.statusDate !== -1 ? toDateStr(r[idx.statusDate]) : null,
      reason: idx.reason !== -1 ? orNull(r[idx.reason]) : null,
      outlook: idx.outlook !== -1 ? orNull(r[idx.outlook]) : null,
      outlook_detail: idx.outlookDetail !== -1 ? orNull(r[idx.outlookDetail]) : null,
      volume_status: volume,
      volume_outlook: idx.volumeOutlook !== -1 ? orNull(r[idx.volumeOutlook]) : null,
      volume_amount: idx.volumeAmount !== -1 ? orNull(r[idx.volumeAmount]) : null,
      info_date: idx.infoDate !== -1 ? toDateStr(r[idx.infoDate]) : null,
      is_new: idx.isNew !== -1 ? toStr(r[idx.isNew]).toLowerCase() === 'new' : false,
      is_adjusting: judgeAdjusting(status, volume),
    });
  }
  return Array.from(map.values());
};

// Supabase は1回の取得が最大1000件のため、ページングで全件取得
const fetchAll = async <T,>(table: string, columns: string): Promise<T[]> => {
  const PAGE = 1000;
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < PAGE) break;
  }
  return all;
};

const ShipmentStatusImport: React.FC<ShipmentStatusImportProps> = ({ storeId, stores }) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedRow[] | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState<'success' | 'error' | 'info' | ''>('');
  const [lastImport, setLastImport] = useState<{ at: string; file: string | null; count: number } | null>(null);
  const [report, setReport] = useState<StoreReport[] | null>(null);
  const [isReporting, setIsReporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 自店の出荷調整対象医薬品一覧用
  const [adjustingItems, setAdjustingItems] = useState<{ stock: RealtimeStock; shipment: ShipmentLookup }[]>([]);
  const [isAdjustingLoading, setIsAdjustingLoading] = useState<boolean>(false);
  const [adjustingPage, setAdjustingPage] = useState<number>(1);
  const [adjustingPageInput, setAdjustingPageInput] = useState<string>('1');
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const ITEMS_PER_PAGE = 20;

  const totalAdjustingPages = Math.ceil(adjustingItems.length / ITEMS_PER_PAGE) || 1;

  useEffect(() => {
    setAdjustingPageInput(String(adjustingPage));
  }, [adjustingPage]);

  const handleAdjustingPageSubmit = () => {
    const parsed = parseInt(adjustingPageInput, 10);
    if (isNaN(parsed)) {
      setAdjustingPageInput(String(adjustingPage));
      return;
    }
    const clamped = Math.max(1, Math.min(totalAdjustingPages, parsed));
    setAdjustingPage(clamped);
    setAdjustingPageInput(String(clamped));
  };

  const currentStoreName = stores.find(s => s.id === storeId)?.name || '未設定の店舗';

  const loadLastImport = async () => {
    try {
      const { data, error } = await supabase
        .from('shipment_status')
        .select('imported_at,source_file')
        .order('imported_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      const { count } = await supabase.from('shipment_status').select('yj_code', { count: 'exact', head: true });
      if (data && data.length > 0) setLastImport({ at: data[0].imported_at, file: data[0].source_file, count: count || 0 });
      else setLastImport(null);
    } catch {
      setLastImport(null);
    }
  };

  const loadAdjustingStocks = useCallback(async () => {
    if (!storeId) return;
    setIsAdjustingLoading(true);
    try {
      const { data: stocks, error } = await supabase
        .from('realtime_stocks')
        .select('id, store_id, name, spec, stock_qty, unit, yakka_code, expiry_date, updated_at, stock_updated_at')
        .eq('store_id', storeId)
        .order('name');

      if (error) throw error;
      if (!stocks || stocks.length === 0) {
        setAdjustingItems([]);
        return;
      }

      const lookups = await lookupShipment(stocks.map(s => ({ name: s.name, yakka_code: s.yakka_code })));

      const filtered = stocks.map((stock, idx) => ({
        stock: stock as RealtimeStock,
        shipment: lookups[idx]
      })).filter(item => {
        if (!item.shipment) return false;
        if (item.shipment.kind === 'ambiguous') return true;
        return !!getShipmentBadge(item.shipment.rows);
      });

      setAdjustingItems(filtered);
      setAdjustingPage(1);
    } catch (err) {
      console.error('自店出荷調整対象薬品の取得エラー:', err);
    } finally {
      setIsAdjustingLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    loadLastImport();
    loadAdjustingStocks();
  }, [storeId, loadAdjustingStocks]);

  const setMsg = (text: string, type: 'success' | 'error' | 'info' | '') => { setMessage(text); setMessageType(type); };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setMsg('', '');
    setParsed(null);
    setReport(null);
    const file = e.target.files?.[0];
    if (!file) { setSelectedFile(null); return; }
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setSelectedFile(null);
      setMsg('.xlsx ファイルを選択してください。', 'error');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setSelectedFile(file);
    setIsParsing(true);
    setMsg('ファイルを解析しています（数秒かかります）...', 'info');
    try {
      const rows = await parseWorkbook(file);
      if (rows.length === 0) throw new Error('有効なデータが見つかりませんでした。');
      setParsed(rows);
      setMsg(`${file.name} を解析しました。内容を確認して「取り込む」を押してください。`, 'info');
    } catch (err) {
      setSelectedFile(null);
      setMsg(err instanceof Error ? err.message : '解析に失敗しました', 'error');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } finally {
      setIsParsing(false);
    }
  };

  const handleImport = async () => {
    if (!parsed || !selectedFile) return;
    setIsLoading(true);
    setMsg('', '');
    try {
      const importedAt = new Date().toISOString();
      const BATCH = 1000;
      // まず全件を upsert（途中で失敗しても既存データは消えない）
      for (let i = 0; i < parsed.length; i += BATCH) {
        setProgress(`保存中... ${Math.min(i + BATCH, parsed.length).toLocaleString()} / ${parsed.length.toLocaleString()} 件`);
        const batch = parsed.slice(i, i + BATCH).map(r => ({ ...r, source_file: selectedFile.name, imported_at: importedAt }));
        const { error } = await supabase.from('shipment_status').upsert(batch, { onConflict: 'yj_code' });
        if (error) throw new Error(`保存に失敗しました（${i + 1}件目〜）: ${error.message}`);
      }
      // 全件の保存に成功したら、今回のファイルに含まれない古い行（掲載終了品目）を削除
      setProgress('古いデータを整理中...');
      const { error: delErr } = await supabase.from('shipment_status').delete().lt('imported_at', importedAt);
      if (delErr) throw new Error(`古いデータの整理に失敗しました: ${delErr.message}`);

      setMsg(`✓ 出荷状況を ${parsed.length.toLocaleString()} 件取り込みました`, 'success');
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await loadLastImport();
      await loadAdjustingStocks();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '取り込みに失敗しました', 'error');
    } finally {
      setIsLoading(false);
      setProgress('');
    }
  };

  // 店舗別の突合率チェック（現在庫 realtime_stocks に対して実施）
  const runReport = async () => {
    setIsReporting(true);
    setReport(null);
    try {
      const [ship, stocks] = await Promise.all([
        fetchAll<{ yj_code: string; name_key: string }>('shipment_status', 'yj_code,name_key'),
        fetchAll<{ store_id: string; name: string; yakka_code: string | null }>('realtime_stocks', 'store_id,name,yakka_code'),
      ]);
      if (ship.length === 0) throw new Error('出荷状況データがありません。先に取り込みを行ってください。');

      const codeSet = new Set(ship.map(s => s.yj_code));
      const nameCount = new Map<string, number>();
      const nameToCode = new Map<string, string>();
      ship.forEach(s => {
        nameCount.set(s.name_key, (nameCount.get(s.name_key) || 0) + 1);
        nameToCode.set(s.name_key, s.yj_code);
      });
      // 辞書：他店の在庫（有効なYJコードあり）から 名称→YJコード
      const dict = new Map<string, string>();
      stocks.forEach(s => { if (isValidYjCode(s.yakka_code)) dict.set(normalizeName(s.name), (s.yakka_code as string).trim()); });

      const byStore = new Map<string, StoreReport>();
      stocks.forEach(s => {
        const st = byStore.get(s.store_id) || {
          storeName: stores.find(x => x.id === s.store_id)?.name || '不明',
          total: 0, code: 0, name: 0, dict: 0, ambiguous: 0, none: 0,
        };
        st.total++;
        const code = (s.yakka_code || '').trim();
        const key = normalizeName(s.name);
        const cnt = nameCount.get(key) || 0;
        if (isValidYjCode(code) && codeSet.has(code)) st.code++;
        else if (cnt === 1) st.name++;
        else if (cnt > 1) st.ambiguous++;
        else if (dict.has(key) && codeSet.has(dict.get(key)!)) st.dict++;
        else st.none++;
        byStore.set(s.store_id, st);
      });
      setReport(Array.from(byStore.values()));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '突合率チェックに失敗しました', 'error');
    } finally {
      setIsReporting(false);
    }
  };

  const summary = parsed ? {
    total: parsed.length,
    normal: parsed.filter(r => !r.is_adjusting).length,
    adjusting: parsed.filter(r => r.is_adjusting).length,
    stop: parsed.filter(r => r.status.includes('供給停止')).length,
    limited: parsed.filter(r => r.status.includes('限定出荷')).length,
    reduced: parsed.filter(r => r.volume_status && !/^A/.test(r.volume_status)).length,
  } : null;

  const pct = (n: number, t: number) => (t === 0 ? '-' : `${Math.round((n / t) * 100)}%`);

  return (
    <div className="w-full max-w-4xl mx-auto p-6 space-y-6 animate-in fade-in">
      <div className="flex items-center justify-between border-b pb-6 border-slate-200">
        <div>
          <h1 className="text-2xl font-black text-slate-900 flex items-center gap-3">
            <FileSpreadsheet className="w-8 h-8 text-blue-600" />
            出荷状況インポート
          </h1>
          <p className="text-slate-500 text-sm font-bold mt-1 uppercase tracking-wider">Shipment Status Import</p>
        </div>
        <div className="bg-slate-900 text-white px-6 py-3 rounded-2xl flex items-center gap-3 shadow-lg">
          <Building2 className="w-5 h-5 text-blue-400" />
          <span className="text-sm font-black">{currentStoreName}</span>
        </div>
      </div>

      {/* 現在の取込状況 */}
      <div className="bg-white border-2 border-slate-100 rounded-[24px] p-5 flex flex-wrap items-center gap-x-8 gap-y-2 text-xs font-bold text-slate-600">
        <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">現在のデータ</div>
        {lastImport ? (
          <>
            <div>取込日時：<span className="text-slate-900">{new Date(lastImport.at).toLocaleString('ja-JP')}</span></div>
            <div>件数：<span className="text-slate-900">{lastImport.count.toLocaleString()}件</span></div>
            <div className="truncate max-w-xs">ファイル：<span className="text-slate-900">{lastImport.file || '-'}</span></div>
          </>
        ) : (
          <div className="text-slate-400">まだ取り込まれていません（または shipment_status テーブルが未作成です）</div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 space-y-4">
          <div className={`relative border-4 border-dashed rounded-[32px] p-10 transition-all flex flex-col items-center justify-center text-center ${
            selectedFile ? 'bg-blue-50 border-blue-400' : 'bg-white border-slate-200 hover:border-blue-300'
          }`}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              onChange={handleFileChange}
              disabled={isLoading || isParsing}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
            />
            <div className={`p-5 rounded-3xl mb-4 ${selectedFile ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
              <FileSpreadsheet size={40} />
            </div>
            <h3 className="text-lg font-black text-slate-800">
              {selectedFile ? selectedFile.name : '供給状況のExcelをドロップ'}
            </h3>
            <p className="text-xs text-slate-400 font-bold mt-2">厚労省「医療用医薬品の供給状況」 .xlsx</p>
          </div>

          {message && (
            <div className={`p-4 rounded-2xl flex items-center gap-3 border-2 ${
              messageType === 'success' ? 'bg-green-50 border-green-200 text-green-700' :
              messageType === 'error' ? 'bg-red-50 border-red-200 text-red-700' :
              'bg-blue-50 border-blue-200 text-blue-700'
            }`}>
              {messageType === 'success' ? <CheckCircle size={20} /> :
               messageType === 'error' ? <AlertCircle size={20} /> : <Info size={20} />}
              <span className="text-sm font-bold">{message}</span>
            </div>
          )}

          {summary && (
            <div className="bg-white border-2 border-slate-100 rounded-[24px] p-5">
              <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">解析結果（取込前の確認）</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-center">
                <div className="bg-slate-50 rounded-xl p-3"><div className="text-xl font-black text-slate-800">{summary.total.toLocaleString()}</div><div className="text-[10px] font-bold text-slate-400">全品目</div></div>
                <div className="bg-slate-50 rounded-xl p-3"><div className="text-xl font-black text-slate-800">{summary.normal.toLocaleString()}</div><div className="text-[10px] font-bold text-slate-400">通常</div></div>
                <div className="bg-amber-50 rounded-xl p-3"><div className="text-xl font-black text-amber-700">{summary.adjusting.toLocaleString()}</div><div className="text-[10px] font-bold text-amber-600">出荷調整中</div></div>
                <div className="bg-red-50 rounded-xl p-3"><div className="text-xl font-black text-red-600">{summary.stop.toLocaleString()}</div><div className="text-[10px] font-bold text-red-500">供給停止</div></div>
                <div className="bg-amber-50 rounded-xl p-3"><div className="text-xl font-black text-amber-700">{summary.limited.toLocaleString()}</div><div className="text-[10px] font-bold text-amber-600">限定出荷</div></div>
                <div className="bg-orange-50 rounded-xl p-3"><div className="text-xl font-black text-orange-600">{summary.reduced.toLocaleString()}</div><div className="text-[10px] font-bold text-orange-500">出荷量 減少・停止等</div></div>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <button
            onClick={handleImport}
            disabled={!parsed || isLoading || isParsing}
            className={`w-full h-32 rounded-[32px] flex flex-col items-center justify-center gap-2 transition-all shadow-xl active:scale-95 ${
              !parsed || isLoading || isParsing
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                : 'bg-blue-600 text-white hover:bg-blue-700 shadow-blue-200'
            }`}
          >
            {isLoading || isParsing ? <RefreshCw className="animate-spin" size={32} /> : <Upload size={32} />}
            <span className="font-black text-lg">取り込む</span>
            {progress && <span className="text-[10px] font-bold">{progress}</span>}
          </button>

          <div className="bg-amber-50 border border-amber-200 p-5 rounded-[24px]">
            <div className="flex items-center gap-2 text-amber-700 mb-2 font-black text-xs">
              <FileWarning size={16} />
              <span>注意点</span>
            </div>
            <ul className="text-[11px] text-amber-800 font-bold space-y-2 leading-relaxed">
              <li>• 出荷状況は全店共通です。最新のファイルで内容が置き換わります。</li>
              <li>• 今回のファイルに載っていない品目は削除されます。</li>
              <li>• 在庫データには影響しません。</li>
            </ul>
          </div>
        </div>
      </div>

      {/* 突合率チェック */}
      <div className="bg-white border-2 border-slate-100 rounded-[24px] p-6 space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-sm font-black text-slate-800 flex items-center gap-2"><BarChart3 size={16} className="text-blue-600" />店舗別 突合率チェック</h2>
            <p className="text-[11px] text-slate-400 font-bold mt-1">各店舗の現在庫が、出荷状況データとどれだけ照合できているかを確認します。</p>
          </div>
          <button
            onClick={runReport}
            disabled={isReporting}
            className="px-5 py-2.5 rounded-xl bg-slate-900 text-white font-black text-xs hover:bg-slate-700 transition-all disabled:opacity-50 flex items-center gap-2"
          >
            {isReporting ? <RefreshCw size={14} className="animate-spin" /> : <BarChart3 size={14} />}
            チェックを実行
          </button>
        </div>
        {report && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-bold text-slate-600">
              <thead>
                <tr className="text-[10px] text-slate-400 uppercase tracking-widest border-b border-slate-100">
                  <th className="text-left py-2">店舗</th>
                  <th className="text-right py-2">在庫品目</th>
                  <th className="text-right py-2">コード一致</th>
                  <th className="text-right py-2">名称一致</th>
                  <th className="text-right py-2">辞書補完</th>
                  <th className="text-right py-2 text-amber-600">要確認</th>
                  <th className="text-right py-2">情報なし</th>
                  <th className="text-right py-2">一致率</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {report.map(r => (
                  <tr key={r.storeName}>
                    <td className="py-2 text-slate-800">{r.storeName}</td>
                    <td className="py-2 text-right tabular-nums">{r.total.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums">{r.code.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums">{r.name.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums">{r.dict.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums text-amber-600">{r.ambiguous.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums text-slate-400">{r.none.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums text-blue-600 font-black">{pct(r.code + r.name + r.dict, r.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[10px] text-slate-400 font-bold mt-3 flex items-start gap-1">
              <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
              「情報なし」には、厚労省の一覧に載っていない品目（医療材料・未収載品・一般用など）も含まれます。
            </p>
          </div>
        )}
      </div>

      {/* 選択店舗の出荷調整対象医薬品一覧 */}
      <div className="bg-white border-2 border-slate-100 rounded-[24px] p-6 space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-sm font-black text-slate-800 flex items-center gap-2">
              <Truck size={18} className="text-amber-500" />
              【{currentStoreName}】在庫中の出荷調整対象医薬品
            </h2>
            <p className="text-[11px] text-slate-400 font-bold mt-1">
              選択されている店舗の現在庫のうち、出荷制限や供給停止が該当する医薬品の一覧です。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-black bg-amber-50 text-amber-700 px-3 py-1.5 rounded-xl border border-amber-200">
              {adjustingItems.length.toLocaleString()} 品目
            </span>
            <button
              onClick={() => loadAdjustingStocks()}
              disabled={isAdjustingLoading}
              className="p-2 rounded-xl bg-slate-100 text-slate-600 hover:bg-slate-200 transition-all disabled:opacity-50"
              title="一覧を更新"
            >
              <RefreshCw size={14} className={isAdjustingLoading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {isAdjustingLoading ? (
          <div className="text-center py-12 text-slate-400 font-bold text-xs flex items-center justify-center gap-2">
            <RefreshCw size={16} className="animate-spin text-blue-600" /> 在庫データと照合中...
          </div>
        ) : adjustingItems.length > 0 ? (
          <div className="space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-bold text-slate-700">
                <thead>
                  <tr className="text-[10px] text-slate-400 uppercase tracking-widest border-b border-slate-100">
                    <th className="text-left py-2.5 px-3">薬品名</th>
                    <th className="text-right py-2.5 px-3 w-[12%]">現在庫数</th>
                    <th className="text-center py-2.5 px-3 w-[8%]">単位</th>
                    <th className="text-center py-2.5 px-3 w-[18%]">出荷状況</th>
                    <th className="text-center py-2.5 px-3 w-[10%]">詳細</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {adjustingItems
                    .slice((adjustingPage - 1) * ITEMS_PER_PAGE, adjustingPage * ITEMS_PER_PAGE)
                    .map(({ stock, shipment }) => {
                      const isExpanded = expandedItemId === stock.id;
                      return (
                        <React.Fragment key={stock.id}>
                          <tr className="hover:bg-slate-50/80 transition-colors">
                            <td className="py-3 px-3">
                              <div className="font-black text-slate-800">{stock.name}</div>
                              <div className="text-[10px] text-slate-400 font-mono tracking-tighter">
                                {stock.spec} {stock.yakka_code ? `(${stock.yakka_code})` : ''}
                              </div>
                            </td>
                            <td className="py-3 px-3 text-right font-black text-blue-600 text-sm tabular-nums">
                              {stock.stock_qty.toLocaleString()}
                            </td>
                            <td className="py-3 px-3 text-center text-slate-500">{stock.unit}</td>
                            <td className="py-3 px-3 text-center">
                              <ShipmentBadge lookup={shipment} />
                            </td>
                            <td className="py-3 px-3 text-center">
                              <button
                                onClick={() => setExpandedItemId(isExpanded ? null : stock.id)}
                                className="px-2.5 py-1 rounded-lg bg-slate-100 text-slate-600 hover:bg-blue-50 hover:text-blue-600 transition-all text-[11px] font-bold flex items-center gap-1 mx-auto"
                              >
                                {isExpanded ? '閉じる' : '詳細'}
                                {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                              </button>
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="bg-slate-50/90 border-l-4 border-l-amber-500">
                              <td colSpan={5} className="p-4">
                                <div className="space-y-2">
                                  <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                                    <Truck size={12} /> 厚労省 供給状況の詳細
                                  </div>
                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    {shipment.rows.map(r => (
                                      <div key={r.yj_code} className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm text-xs font-bold space-y-1">
                                        <div className="text-slate-900 font-black flex justify-between">
                                          <span>{r.name}</span>
                                          <span className="text-slate-400 text-[10px] font-mono">{r.yj_code}</span>
                                        </div>
                                        <div className="text-amber-700">{r.status} {r.volume_status ? ` / ${r.volume_status}` : ''}</div>
                                        {r.reason && <div className="text-slate-600 text-[11px]">理由: {r.reason}</div>}
                                        {r.outlook && <div className="text-slate-600 text-[11px]">解消時期: {r.outlook} {r.outlook_detail || ''}</div>}
                                        {r.status_date && <div className="text-slate-400 text-[10px]">更新日: {r.status_date}</div>}
                                      </div>
                                    ))}
                                  </div>
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

            {/* ページネーション */}
            {adjustingItems.length > ITEMS_PER_PAGE && (
              <div className="flex items-center justify-between pt-2 border-t border-slate-100 flex-wrap gap-2">
                <div className="text-xs font-bold text-slate-500">
                  {(adjustingPage - 1) * ITEMS_PER_PAGE + 1} 〜 {Math.min(adjustingPage * ITEMS_PER_PAGE, adjustingItems.length)} 件表示 / 全 {adjustingItems.length.toLocaleString()} 件
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setAdjustingPage(p => Math.max(1, p - 1))}
                    disabled={adjustingPage === 1}
                    className="p-2 rounded-xl bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-all font-bold text-xs flex items-center gap-1"
                  >
                    <ChevronLeft size={14} /> 前へ
                  </button>

                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700 bg-slate-100 px-2 py-1 rounded-xl border border-slate-200">
                    <input
                      type="number"
                      min={1}
                      max={totalAdjustingPages}
                      value={adjustingPageInput}
                      onChange={(e) => setAdjustingPageInput(e.target.value)}
                      onBlur={handleAdjustingPageSubmit}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleAdjustingPageSubmit();
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      className="w-12 bg-white text-center text-slate-900 text-xs font-bold py-0.5 rounded border border-slate-300 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <span className="text-slate-500">/ {totalAdjustingPages} ページ</span>
                  </div>

                  <button
                    onClick={() => setAdjustingPage(p => Math.min(totalAdjustingPages, p + 1))}
                    disabled={adjustingPage >= totalAdjustingPages}
                    className="p-2 rounded-xl bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-all font-bold text-xs flex items-center gap-1"
                  >
                    次へ <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-10 bg-slate-50/50 rounded-2xl border-2 border-dashed border-slate-100">
            <Package className="w-10 h-10 text-slate-300 mx-auto mb-2" />
            <p className="text-xs font-bold text-slate-400">
              現在、{currentStoreName} に在庫がある品目の中に出荷調整対象の医薬品はありません
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default ShipmentStatusImport;
