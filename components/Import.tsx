
import React, { useState, useRef } from 'react';
import { InventoryItem } from '../types';
import { supabase } from '../supabase';
import { Upload, FileText, CheckCircle, AlertTriangle, RefreshCw, Terminal, XCircle, Eye, Pin, PinOff, ChevronRight, PackageCheck, Ghost, ShieldAlert, Store as StoreIcon } from 'lucide-react';

interface Props {
  inventory: InventoryItem[];
  setInventory: React.Dispatch<React.SetStateAction<InventoryItem[]>>;
  currentStoreId: string;
  stores: { id: string; name: string }[];
}

interface ImportReport {
  newItems: InventoryItem[];
  disappearedItems: InventoryItem[];
  lockedItems: InventoryItem[];
}

const Import: React.FC<Props> = ({ inventory, setInventory, currentStoreId, stores }) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [activeCategory, setActiveCategory] = useState<keyof ImportReport | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addLog = (msg: string) => setLogs(prev => [...prev, `${new Date().toLocaleTimeString()} - ${msg}`].slice(-30));

  const splitCsvLine = (line: string): string[] => {
    const result = [];
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

  const toNum = (val: string) => {
    if (!val) return 0;
    const cleaned = val.replace(/^"|"$/g, '').replace(/,/g, '');
    return parseFloat(cleaned) || 0;
  };

  const toDate = (val: string) => {
    const s = val.trim().replace(/^"|"$/g, '');
    const p = s.split(/[./-]/);
    if (p.length >= 2) return `${p[0]}-${p[1].padStart(2, '0')}-${(p[2] || '01').padStart(2, '0')}`;
    return s;
  };

  /**
   * 3段階の列判定ロジック
   * 1. 完全一致 (Strict Match)
   * 2. 部分一致 (Partial Match)
   * 3. 固定インデックス (Fallback)
   */
  const getIdx = (headers: string[], keywords: string[], fallback: number) => {
    // 1. 完全一致
    const exactIdx = headers.findIndex(h => keywords.some(k => h === k));
    if (exactIdx !== -1) return exactIdx;
    
    // 2. 部分一致 (完全一致がない場合)
    const partialIdx = headers.findIndex(h => keywords.some(k => h.includes(k)));
    if (partialIdx !== -1) return partialIdx;

    // 3. フォールバック
    return fallback;
  };

  const processCsv = (text: string) => {
    setLogs([]);
    setReport(null);
    setActiveCategory(null);
    addLog(`解析を開始します... (インポート先: ${currentStoreId})`);

    const cleanText = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const allLines = cleanText.split('\n').filter(l => l.trim() !== '');
    
    if (allLines.length < 1) {
      addLog("エラー: ファイルが空です。");
      setIsProcessing(false);
      return;
    }

    let headerIdx = -1;
    let headers: string[] = [];
    for (let i = 0; i < Math.min(allLines.length, 10); i++) {
      const cols = splitCsvLine(allLines[i]);
      if (cols.some(c => c.includes("個別医薬品コード") || c.includes("薬品名"))) {
        headerIdx = i;
        headers = cols.map(h => h.replace(/^"|"$/g, '').trim());
        break;
      }
    }

    // 仕様 Index: 3:YJ, 7:名, 8:規格, 11:製造, 12:期限, 16:合計, 17:単位, 19:金額
    const idx = {
      yj: getIdx(headers, ["個別医薬品コード", "YJコード"], 3),
      name: getIdx(headers, ["薬品名"], 7),
      spec: getIdx(headers, ["規格単位"], 8),
      lot: getIdx(headers, ["製造番号"], 11),
      expiry: getIdx(headers, ["使用期限"], 12),
      stock: getIdx(headers, ["在庫数合計", "バラ換算合計"], 16),
      unit: getIdx(headers, ["単位"], 17),
      amount: getIdx(headers, ["在庫金額"], 19)
    };

    addLog(`列マッピング: 薬品名=${idx.name}, 規格=${idx.spec}, 在庫数=${idx.stock}, 単位=${idx.unit}`);

    // 1.3 不要フラグの継承 (Persistence Logic): メモリへ退避
    const prevStoreItems = inventory.filter(i => String(i.store_id) === String(currentStoreId));
    const flagHistory = new Map<string, { is_dead_stock: boolean,
      dead_stock_flag_date: string | null, is_locked:  boolean,
      requested_amounts: Record<string, number> | null,
      adopting_store_ids: string[] | null
    }>();

    prevStoreItems.forEach(i => {
      flagHistory.set(`${i.yakka_code || i.yj_code}-${i.lot_number}-${i.expiry_date}`, {
        is_dead_stock: i.is_dead_stock,
        dead_stock_flag_date: i.dead_stock_flag_date,
        is_locked: i.is_locked,
        requested_amounts: i.requested_amounts,
        adopting_store_ids: i.adopting_store_ids
      });
    });

    const newInventory: InventoryItem[] = [];
    const reportData: ImportReport = { newItems: [], disappearedItems: [], lockedItems: [] };

    for (let i = headerIdx + 1; i < allLines.length; i++) {
      const cols = splitCsvLine(allLines[i]);
      if (cols.length <= Math.max(...Object.values(idx))) continue;

      const stock = toNum(cols[idx.stock]);
      if (stock <= 0) continue; // 物理削除ロジック

      const yj = (cols[idx.yj] || "").replace(/^"|"$/g, '');
      const name = (cols[idx.name] || "").replace(/^"|"$/g, '');
      const lot = (cols[idx.lot] || "不明").replace(/^"|"$/g, '');
      const expiry = toDate(cols[idx.expiry]);
      if (!yj || !name) continue;

      const key = `${yj}-${lot}-${expiry}`;
      const history = flagHistory.get(key);
      const amount = toNum(cols[idx.amount]);

      const item: InventoryItem = {
        id: crypto.randomUUID(),
        store_id: currentStoreId,
        yakka_code: yj,
        name: name,
        spec: (cols[idx.spec] || "").replace(/^"|"$/g, ''),
        lot_number: lot,
        expiry_date: expiry,
        stock_total: stock,
        unit: (cols[idx.unit] || "").replace(/^"|"$/g, ''),
        price: 0,
        total_amount: amount,
        is_dead_stock: history?.is_dead_stock || false, 
        dead_stock_flag_date: history?.dead_stock_flag_date || null,
        is_locked: history?.is_locked || false,
        requested_amounts: history?.requested_amounts || {},
        adopting_store_ids: history?.adopting_store_ids || [],
        updated_at: new Date().toISOString()
      };

      if (!history) {
        reportData.newItems.push(item);
      } else {
        if (item.is_locked) reportData.lockedItems.push(item);
      }
      
      newInventory.push(item);
      flagHistory.delete(key);
    }

    reportData.disappearedItems = Array.from(flagHistory.keys()).map(k => {
      const [yj, lot, expiry] = k.split('-');
      return prevStoreItems.find(i => i.yakka_code === yj && i.lot_number === lot && i.expiry_date === expiry)!;
    }).filter(Boolean);

    setInventory(prev => [
      ...prev.filter(i => String(i.store_id) !== String(currentStoreId)),
      ...newInventory
    ]);

    setReport(reportData);
    addLog(`完了: ${newInventory.length}件の有効在庫を登録しました。`);
    setIsProcessing(false);
  };

  const toggleReportItem = (item: InventoryItem, type: 'dead' | 'locked') => {
    setInventory(prev => prev.map(i => {
      if (i.id === item.id || (i.yakka_code === item.yakka_code && i.lot_number === item.lot_number && i.expiry_date === item.expiry_date && i.store_id === item.store_id)) {
        if (type === 'dead') {
          const turningOn = !i.is_dead_stock;
          return { ...i, is_dead_stock: turningOn, dead_stock_flag_date: turningOn ? new Date().toISOString() : null, dead_stock_qty: turningOn ? i.stock_total : 0 };
        }
        return { ...i, is_locked: !i.is_locked };
      }
      return i;
    }));
    if (report && activeCategory) {
      const updatedList = report[activeCategory].map(i => {
        if (i.id === item.id) {
          if (type === 'dead') {
            const turningOn = !i.is_dead_stock;
            return { ...i, is_dead_stock: turningOn, dead_stock_qty: turningOn ? i.stock_total : 0 };
          }
          return { ...i, is_locked: !i.is_locked };
        }
        return i;
      });
      setReport({ ...report, [activeCategory]: updatedList });
    }
  };

  const currentStoreName = stores.find(s => s.id === currentStoreId)?.name || '店舗未選択';

  return (
    <div className="max-w-5xl mx-auto space-y-8 pb-24 animate-in fade-in">
      {/* 視覚的確認（Visual Confirmation）セクション */}
      <div className="bg-slate-900 rounded-[32px] p-8 text-white shadow-2xl flex flex-col md:flex-row items-center justify-between border border-white/5 relative overflow-hidden group">
        <div className="absolute top-0 right-0 w-64 h-64 bg-blue-500/10 rounded-full -mr-32 -mt-32 blur-3xl group-hover:bg-blue-500/20 transition-all duration-700"></div>
        <div className="flex items-center space-x-6 relative z-10">
          <div className="bg-blue-600 p-4 rounded-3xl shadow-xl shadow-blue-600/30">
            <StoreIcon size={32} />
          </div>
          <div>
            <div className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-400 mb-1">Current Import Target</div>
            <div className="text-2xl font-black tracking-tight">{currentStoreName}</div>
            <div className="text-xs text-slate-400 font-bold mt-1">※ この店舗の在庫データが上書き（洗い替え）されます。</div>
          </div>
        </div>
        <div className="mt-6 md:mt-0 relative z-10">
          <div className="text-[10px] font-black text-slate-500 bg-white/5 border border-white/10 px-4 py-2 rounded-2xl">
            店舗変更は上部のタブを切り替えて行ってください
          </div>
        </div>
      </div>

      <div className="bg-white p-12 rounded-[40px] shadow-2xl border border-slate-100 text-center space-y-10">
        <div className="space-y-4">
          <div className="w-20 h-20 bg-blue-50 text-blue-600 rounded-3xl flex items-center justify-center mx-auto transition-transform hover:rotate-6">
            <Upload size={36} />
          </div>
          <h2 className="text-3xl font-black text-slate-800 tracking-tighter">在庫CSVをインポート</h2>
          <p className="text-slate-500 font-bold max-w-md mx-auto leading-relaxed">
            基幹システムから出力した<span className="text-blue-600 underline underline-offset-4 decoration-blue-200">22項目在庫明細CSV</span>を選択してください。
          </p>
        </div>

        <input ref={fileInputRef} type="file" accept=".csv" onChange={e => {
          const f = e.target.files?.[0];
          if (!f) {
            console.log('ファイルが選択されていません');
            return;
          }
          console.log('ファイル選択:', f.name);
          setIsProcessing(true);
          const r = new FileReader();
          r.readAsText(f, 'Shift_JIS');
          r.onload = async ev => {
            try {
              const text = ev.target?.result as string;
              setIsProcessing(true);
              addLog('サーバーへ送信中...（数秒かかる場合があります）');

              // 1. サーバー（Edge Function）を呼び出してDBを更新させる
              const { data: result, error: funcError } = await supabase.functions.invoke('import-inventory', {
                body: { csv: text, store_id: currentStoreId },
                headers: { 'Content-Type': 'application/json' }
              });

              if (funcError) throw funcError;

              // 2. サーバー側での保存成功を確認
              if (result && result.success) {
                addLog(`サーバー保存完了: ${result.count} 件。最新データを取得しています...`);

                // 3. 【重要】最新の在庫情報をDBから直接読み直す（これでF5不要になる）
                const { data: updatedInventory, error: fetchError } = await supabase
                  .from('inventory_items')
                  .select('*')
                  .eq('store_id', currentStoreId);

                if (fetchError) throw fetchError;

                if (updatedInventory) {
                  // 4. 画面のステートを更新
                  setInventory(prev => [
                    ...prev.filter(i => String(i.store_id) !== String(currentStoreId)),
                    ...updatedInventory
                  ]);
                  addLog(`完了: 在庫リストを更新しました。`);
                  setReport(null); 
                }
              } else {
                addLog('エラー: サーバーからの応答が不正です。');
              }
            } catch (err: any) {
              console.error('インポート失敗:', err);
              addLog(`エラー: ${err.message || '通信に失敗しました'}`);
            } finally {
              setIsProcessing(false);
            }
          };
          r.onerror = () => {
            console.error('ファイル読み込みエラー');
            addLog("エラー: ファイルの読み込み中に障害が発生しました。");
            setIsProcessing(false);
          };
        }} className="hidden" id="csv-upload-main" />
        
        <label htmlFor="csv-upload-main" className={`group flex flex-col items-center justify-center w-full h-64 border-4 border-dashed rounded-[40px] cursor-pointer transition-all ${isProcessing ? 'bg-slate-50 border-slate-200' : 'hover:bg-blue-50 border-slate-200 hover:border-blue-400'}`}>
          {isProcessing ? (
            <div className="flex flex-col items-center space-y-4">
              <RefreshCw className="animate-spin text-blue-500" size={48} />
              <span className="font-black text-blue-600 uppercase tracking-widest text-xs">データ正規化・解析中...</span>
            </div>
          ) : (
            <div className="flex flex-col items-center space-y-4">
              <FileText size={64} className="text-slate-200 group-hover:text-blue-300 transition-colors" />
              <span className="font-black text-slate-400 group-hover:text-blue-600 transition-colors text-lg">ファイルを選択して開始</span>
              <span className="text-[10px] bg-slate-100 text-slate-400 px-4 py-1.5 rounded-full font-bold uppercase tracking-widest">Shift-JIS / 列自動判定 / 0件除外</span>
            </div>
          )}
        </label>

        {report && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 animate-in slide-in-from-bottom-4">
            {[
              { id: 'newItems', label: '新規登録', color: 'blue', count: report.newItems.length, icon: PackageCheck },
              { id: 'disappearedItems', label: '解消(消失)候補', color: 'slate', count: report.disappearedItems.length, icon: Ghost },
              { id: 'lockedItems', label: 'キープ中', color: 'blue', count: report.lockedItems.length, icon: ShieldAlert }
            ].map(cat => (
              <button 
                key={cat.id} 
                onClick={() => setActiveCategory(cat.id as any)} 
                className={`p-8 rounded-3xl border-2 transition-all text-left flex items-start justify-between shadow-sm hover:shadow-xl ${activeCategory === cat.id ? `border-${cat.color}-500 bg-${cat.color}-50 ring-4 ring-${cat.color}-500/10` : 'border-slate-100 bg-white hover:border-slate-200'}`}
              >
                <div>
                  <div className={`text-[10px] font-black uppercase text-slate-400 mb-2 tracking-[0.2em]`}>{cat.label}</div>
                  <div className="text-5xl font-black text-slate-800 tabular-nums leading-none mb-4">{cat.count}<span className="text-sm ml-2 font-bold text-slate-300">items</span></div>
                  <div className={`flex items-center text-[10px] font-black text-${cat.color}-500 group-hover:translate-x-1 transition-transform`}>
                    詳細リストを表示 <ChevronRight size={14} className="ml-1" />
                  </div>
                </div>
                <cat.icon className={`text-${cat.color}-100 mt-2`} size={40} />
              </button>
            ))}
          </div>
        )}

        {activeCategory && report && (
          <div className="bg-slate-50 border rounded-[32px] overflow-hidden text-left animate-in zoom-in-95 duration-200 shadow-inner">
            <div className="p-6 bg-white border-b flex items-center justify-between">
              <h3 className="text-xs font-black uppercase text-slate-500 flex items-center tracking-widest">
                <div className="w-2 h-2 rounded-full bg-blue-500 mr-3 animate-pulse"></div>
                {activeCategory === 'newItems' ? '新規登録品目' : activeCategory === 'disappearedItems' ? '解消候補（今回のCSVには未記載）' : 'キープ中の該当品目'}
              </h3>
              <button onClick={() => setActiveCategory(null)} className="p-2 hover:bg-slate-100 rounded-xl transition-colors text-slate-400">
                <XCircle size={24} />
              </button>
            </div>
            <div className="max-h-96 overflow-y-auto custom-scrollbar">
              <table className="w-full text-xs border-collapse">
                <thead className="sticky top-0 bg-slate-50/98 backdrop-blur shadow-sm z-10">
                  <tr className="text-slate-400 uppercase tracking-widest font-black text-[9px] border-b">
                    <th className="px-6 py-4">薬品名 / 規格</th>
                    <th className="px-6 py-4 text-right">在庫数 / 金額</th>
                    <th className="px-6 py-4 text-center">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200/50">
                  {report[activeCategory].map(item => (
                    <tr key={item.id} className="hover:bg-white/90 transition-colors">
                      <td className="px-6 py-5">
                        <div className="font-black text-slate-800 text-sm leading-tight">{item.name}</div>
                        <div className="text-[10px] text-slate-400 font-bold mt-1 uppercase tracking-tight">{item.spec}</div>
                      </td>
                      <td className="px-6 py-5 text-right">
                        <div className="font-black text-slate-700 text-base tabular-nums">¥{(item.total_amount || 0).toLocaleString()}</div>
                        <div className="text-[10px] text-slate-400 font-bold mt-0.5">{(item.stock_total || 0).toLocaleString()}{item.unit}</div>
                      </td>
                      <td className="px-6 py-5">
                        <div className="flex items-center justify-center space-x-3">
                          <button 
                            onClick={() => toggleReportItem(item, 'dead')} 
                            className={`p-3 rounded-2xl transition-all shadow-sm flex items-center space-x-2 ${item.is_dead_stock ? 'bg-red-600 text-white shadow-red-200' : 'bg-white border border-slate-200 text-slate-300 hover:text-red-500 hover:border-red-500'}`}
                          >
                            <Eye size={16} />
                            <span className="text-[10px] font-black uppercase tracking-tighter">{item.is_dead_stock ? '不動在庫' : '通常'}</span>
                          </button>
                          <button 
                            onClick={() => toggleReportItem(item, 'locked')} 
                            className={`p-3 rounded-2xl transition-all shadow-sm flex items-center space-x-2 ${item.is_locked ? 'bg-blue-600 text-white shadow-blue-200' : 'bg-white border border-slate-200 text-slate-300 hover:text-blue-600 hover:border-blue-600'}`}
                          >
                            {item.is_locked ? <Pin size={16} /> : <PinOff size={16} />}
                            <span className="text-[10px] font-black uppercase tracking-tighter">{item.is_locked ? 'キープ' : '解除'}</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {report[activeCategory].length === 0 && (
                <div className="py-20 text-center font-black text-slate-300 uppercase tracking-widest text-xs">
                  対象品目はありません
                </div>
              )}
            </div>
          </div>
        )}

        <div className="bg-slate-900 rounded-[32px] p-8 text-left font-mono text-[10px] leading-relaxed text-blue-400 h-48 overflow-y-auto custom-scrollbar border border-slate-800 shadow-inner">
          <div className="flex items-center space-x-2 mb-4 border-b border-slate-800 pb-3">
            <Terminal size={14} className="text-blue-500" />
            <span className="font-black uppercase tracking-widest text-slate-500">Processing Logs</span>
          </div>
          {logs.length === 0 && <div className="text-slate-700 italic">Ready for input...</div>}
          {logs.map((log, i) => (
            <div key={i} className={`py-1 border-l-2 pl-4 mb-1 ${log.includes('エラー') ? 'border-red-500 text-red-400' : 'border-blue-900 text-blue-400'}`}>
              {log}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Import;
