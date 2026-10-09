
  import React, { useState, useMemo } from 'react';
  import { InventoryItem, Store } from '../types';
  import { Search, Globe, CheckSquare, Package, Pin, PinOff, ChevronUp, ChevronDown, Store as StoreIcon, AlertTriangle } from 'lucide-react';

  interface Props {
    inventory: InventoryItem[];
    onUpdateItem: (id: string, patch: Partial<InventoryItem>) => void;
    onUpdateItems: (ids: string[], patch: Partial<InventoryItem>) => void;
    currentStoreId: string;
    stores: Store[];
    filterCodes: string[] | null;
    onClearFilter: () => void;
  }

  type SortState = {
    key: keyof InventoryItem;
    order: 'asc' | 'desc';
  };

  const InventoryList: React.FC<Props> = ({ inventory, onUpdateItem, currentStoreId, stores,filterCodes,onClearFilter
  }) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [onlyUnneeded, setOnlyUnneeded] = useState(false);
    const [hideExpired, setHideExpired] = useState(true);
    const [globalSearch, setGlobalSearch] = useState(false);
    const [sorts, setSorts] = useState<SortState[]>([{ key: 'expiry_date', order: 'asc' }]);
    
    const handleBulkUpdate = (yakkaCode: string) => {
      const targets = inventory.filter(item => (item.yakka_code || item.yj_code) === yakkaCode);
      const targetIds = targets.map(item => item.id);
      // 一括設定時も、個別トグルと同じく「在庫数全部」を初期値にする
      targets.forEach(item => {
        onUpdateItem(item.id, {
          is_dead_stock: true,
          dead_stock_flag_date: new Date().toISOString(),
          dead_stock_qty: item.stock_total
        });
      });
    };

    const handleSort = (key: keyof InventoryItem) => {
      setSorts((prev: SortState[]): SortState[] => {
        const index = prev.findIndex(s => s.key === key);
        // 第1優先（index 0）なら昇順/降順トグル
        if (index === 0) {
          if (prev[0].order === 'asc') return [{ key, order: 'desc' as const }, ...prev.slice(1)];
          return prev.slice(1); // 降順の次はソート解除
        }
        // すでにリストにあるが第1優先でない場合は第1優先へ移動
        if (index > 0) {
          return [{ key, order: prev[index].order }, ...prev.filter((_, i) => i !== index)];
        }
        // 新規ソート条件の追加（最大3つ）
        return [{ key, order: 'asc' as const }, ...prev].slice(0, 3);
      });
    };

    const toggleFlag = (id: string, type: 'dead' | 'locked'| 'unneeded') => {
      const item = inventory.find(i => i.id === id);
      if (!item) return;

      // 'dead' または 'unneeded' の場合に不要フラグを立てる
      if (type === 'dead' || type === 'unneeded') {
        const turningOn = !item.is_dead_stock;
        onUpdateItem(id, {
          is_dead_stock: turningOn,
          dead_stock_flag_date: turningOn ? new Date().toISOString() : null,
          // ONにした直後は「在庫数全部」を初期値にする。OFFにしたら0に戻す
          dead_stock_qty: turningOn ? item.stock_total : 0
        });
        return;
      }
      // ロックの処理 (locked が来た時)
      if (type === 'locked') {
        onUpdateItem(id, { is_locked: !item.is_locked });
      }
    };

    // 不要数量の変更（不動在庫チェック済みの品目のみ使用）
    const handleQtyChange = (id: string, value: string, max: number) => {
      let num = parseFloat(value);
      if (isNaN(num) || num < 0) num = 0;
      if (num > max) num = max;
      onUpdateItem(id, { dead_stock_qty: num });
    };

    const filteredInventory = useMemo(() => {
      const today = new Date().toISOString().split('T')[0];
      const s = searchTerm.toLowerCase();
      const isActualGlobal = globalSearch || currentStoreId === 'all';

      let list = inventory.filter(item => {  
        const matchesStore = isActualGlobal ? true : String(item.store_id) === String(currentStoreId);
        return matchesStore;
      });

      if (filterCodes && filterCodes.length > 0) {
        list = list.filter(item => {
          const code = item.yakka_code || item.yj_code || '';
          
          // そもそも修正対象のコードに含まれていないなら除外
          if (!filterCodes.includes(code)) return false;

          // 【重要】自店の中だけで、この薬品に異なるフラグ（True/False）が混在しているか確認
          const sameMedicineInMyStore = list.filter(i => (i.yakka_code || i.yj_code) === code);
          const hasMixedFlags = new Set(sameMedicineInMyStore.map(i => i.is_dead_stock)).size > 1;

          return hasMixedFlags; 
        });
      } else {
        // 通常モードの検索・フィルタ
        list = list.filter(item => {
        const matchesSearch = 
          (item.name?.toLowerCase()?.includes(s) ?? false) ||
          (item.yakka_code?.includes(s) ?? false) ||
          (item.spec?.toLowerCase()?.includes(s) ?? false);
        
        const matchesUnneeded = onlyUnneeded ? item.is_dead_stock : true;
        const matchesExpired = hideExpired ? (item.expiry_date || '9999-12-31') >= today : true;

        return matchesSearch && matchesUnneeded && matchesExpired;
      });
    }

      if (sorts.length > 0||s) {
      list = [...list].sort((a, b) => {
        // 1. 検索語による先頭一致優先（検索語がある場合のみ）
        const s = searchTerm.trim().toLowerCase();
        if (s) {
          // 比較用に正規化（必要に応じて normalizeQuery 関数をこちらでも定義して使用してください）
          const nameA = (a.name || '').toLowerCase();
          const nameB = (b.name || '').toLowerCase();
          
          const indexA = nameA.indexOf(s);
          const indexB = nameB.indexOf(s);

          // 出現位置が異なる場合、より前方にあるものを優先
          if (indexA !== indexB) {
            if (indexA === -1) return 1;
            if (indexB === -1) return -1;
            return indexA - indexB;
          }
        }

        // 2. ユーザー指定のカスタムソート (期限順、在庫数順など)
        for (const sort of sorts) {
          const valA = a[sort.key];
          const valB = b[sort.key];
          if (valA !== valB) {
            const comparison = typeof valA === 'string' 
              ? (valA as string).localeCompare(valB as string, 'ja', { numeric: true })
              : (valA as number) - (valB as number);
            return sort.order === 'asc' ? comparison : -comparison;
          }
        }
        return 0;
      });
    }

      return list;
    }, [inventory, currentStoreId, searchTerm, onlyUnneeded, hideExpired, globalSearch, sorts, filterCodes]);

    const renderSortIndicator = (key: keyof InventoryItem) => {
      const index = sorts.findIndex(s => s.key === key);
      if (index === -1) return null;
      return (
        <span className="inline-flex items-center ml-1 text-blue-600 font-black">
          <span className="text-[9px] mr-0.5">{index + 1}</span>
          {sorts[index].order === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        </span>
      );
    };

    const todayStr = new Date().toISOString().split('T')[0];

    return (
      <div className="flex flex-col space-y-4 h-full">
        {filterCodes && (
          <div className="bg-amber-600 p-4 rounded-3xl shadow-lg flex items-center justify-between animate-in slide-in-from-top-4 duration-300">
            <div className="flex items-center text-white">
              <AlertTriangle size={20} className="mr-3 text-amber-200" />
              <div>
                <div className="text-sm font-black tracking-tight">設定不整合の修正モード</div>
                <div className="text-[10px] font-bold opacity-80 uppercase tracking-widest">薬価コード単位でフラグを統一してください</div>
              </div>
            </div>
            <button 
              onClick={onClearFilter}
              className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-xl text-[10px] font-black transition-colors border border-white/20"
            >
              フィルタ解除
            </button>
          </div>
        )}
        
      {/* ツールバー (スマホでは縦に並ぶ) */}
      <div className="sticky top-0 z-40 bg-white/95 backdrop-blur-md p-4 md:p-6 rounded-3xl shadow-xl border border-slate-100 flex flex-col gap-4">
        <div className="relative w-full">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input
            type="text"
            placeholder="薬品名, コード, 規格..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-12 pr-4 py-3 bg-slate-100 border-none rounded-2xl focus:ring-2 focus:ring-blue-500 transition-all font-bold text-slate-800 outline-none text-sm"
          />
        </div>

                {/* スマホ用簡易ソート & フィルタ */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar md:hidden">
            <span className="text-[9px] font-black text-slate-400 shrink-0 uppercase">Sort:</span>
            {[
              { label: '期限順', key: 'expiry_date' },
              { label: '在庫数', key: 'stock_total' },
              { label: '名前', key: 'name' }
            ].map(s => {
              const active = sorts[0]?.key === s.key;
              return (
                <button
                  key={s.key}
                  onClick={() => handleSort(s.key as keyof InventoryItem)}
                  className={`px-3 py-1.5 rounded-full text-[10px] font-black whitespace-nowrap transition-all border ${
                    active ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-500 border-slate-200'
                  }`}
                >
                  {s.label} {active && (sorts[0].order === 'asc' ? '↑' : '↓')}
                </button>
              );
            })}
          </div>
        </div>
          
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] font-black text-slate-500 uppercase tracking-widest px-1">
          <label className="flex items-center cursor-pointer hover:text-blue-600 transition-colors">
            <input type="checkbox" checked={globalSearch} onChange={(e) => setGlobalSearch(e.target.checked)} className="mr-2 h-4 w-4 rounded-lg text-blue-600 border-slate-300 focus:ring-blue-500" />
            <Globe size={14} className="mr-1" /> 全店表示
          </label>
          <label className="flex items-center cursor-pointer hover:text-blue-600 transition-colors">
            <input type="checkbox" checked={onlyUnneeded} onChange={(e) => setOnlyUnneeded(e.target.checked)} className="mr-2 h-4 w-4 rounded-lg text-blue-600 border-slate-300 focus:ring-blue-500" />
            不動在庫のみ
          </label>
          <label className="flex items-center cursor-pointer hover:text-blue-600 transition-colors">
            <input type="checkbox" checked={hideExpired} onChange={(e) => setHideExpired(e.target.checked)} className="mr-2 h-4 w-4 rounded-lg text-blue-600 border-slate-300 focus:ring-blue-500" />
            期限内
          </label>
        </div>
      </div>

      {/* メインリスト表示エリア */}
      <div className="flex-1 min-h-0 bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden flex flex-col">
        {filteredInventory.length > 0 ? (
          <div className="flex-1 overflow-auto custom-scrollbar">
            {/* PC向けテーブル (md以上で表示) */}
            <table className="hidden md:table w-full text-left border-separate border-spacing-0 min-w-[1000px] table-fixed">
              <thead className="sticky top-0 z-30 bg-slate-50/95 backdrop-blur-md">
                <tr className="text-slate-400 text-[10px] uppercase tracking-widest font-black select-none">
                  <th onClick={() => handleSort('store_id')} className="px-6 py-4 w-32 cursor-pointer hover:bg-slate-100 transition-colors border-b">店舗 {renderSortIndicator('store_id')}</th>
                  <th onClick={() => handleSort('is_dead_stock')} className="px-6 py-4 w-20 text-center cursor-pointer hover:bg-slate-100 transition-colors border-b">不動 {renderSortIndicator('is_dead_stock')}</th>
                  <th onClick={() => handleSort('is_locked')} className="px-6 py-4 w-20 text-center cursor-pointer hover:bg-slate-100 transition-colors border-b">キープ {renderSortIndicator('is_locked')}</th>
                  <th onClick={() => handleSort('name')} className="px-6 py-4 w-1/3 cursor-pointer hover:bg-slate-100 transition-colors border-b">薬品名 {renderSortIndicator('name')}</th>
                  <th onClick={() => handleSort('stock_total')} className="px-6 py-4 w-28 text-right cursor-pointer hover:bg-slate-100 transition-colors border-b">在庫数 {renderSortIndicator('stock_total')}</th>
                  <th className="px-6 py-4 w-28 text-right border-b">不要数量</th>
                  <th onClick={() => handleSort('expiry_date')} className="px-6 py-4 w-40 cursor-pointer hover:bg-slate-100 transition-colors border-b">使用期限 {renderSortIndicator('expiry_date')}</th>
                  <th onClick={() => handleSort('total_amount')} className="px-6 py-4 w-32 text-right cursor-pointer hover:bg-slate-100 transition-colors border-b">金額 {renderSortIndicator('total_amount')}</th>
                </tr>
              </thead>
              <tbody className="divide-y text-xs font-bold bg-white">
                {filteredInventory.map((item, index, array) => {
                  const storeName = stores.find(s => s.id === item.store_id)?.name || '不明';
                  const isExpired = (item.expiry_date || '9999-12-31') < todayStr;
                  const currentCode = item.yakka_code || item.yj_code;
                  const isFirstOfMedicine = index === 0 || currentCode !== (array[index-1].yakka_code || array[index-1].yj_code);

                  return (
                    <React.Fragment key={item.id}>
                      {filterCodes && isFirstOfMedicine && (
                        <tr className="bg-slate-50 border-y border-slate-200">
                          <td colSpan={8} className="px-6 py-2">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-black text-slate-500">対象: {item.name}</span>
                              <button onClick={() => handleBulkUpdate(currentCode || '')} className="px-3 py-1 bg-blue-600 text-white text-[9px] font-black rounded-lg hover:bg-blue-700 shadow-sm transition-transform active:scale-95">一括で不動在庫に設定</button>
                            </div>
                          </td>
                        </tr>
                      )}

                      <tr className={`group hover:bg-slate-50 transition-colors ${item.is_dead_stock && item.is_locked ? 'bg-orange-50/50' : item.is_dead_stock ? 'bg-red-50/50' : ''}`}>
                        <td className="px-6 py-4 text-slate-500 truncate"><div className="flex items-center"><StoreIcon size={12} className="mr-1 opacity-30" />{storeName}</div></td>
                        <td className="px-6 py-4 text-center">
                          <button title={item.is_dead_stock ? '不動在庫の設定を解除' : '不動在庫に設定'} onClick={() => toggleFlag(item.id, 'unneeded')} className={`p-2 rounded-xl transition-all ${item.is_dead_stock ? 'text-red-600 bg-red-100' : 'text-slate-200 hover:text-slate-400'}`}><CheckSquare size={20} /></button>
                        </td>
                        <td className="px-6 py-4 text-center">
                          <button title={item.is_locked ? 'キープを解除' : 'キープする'} onClick={() => toggleFlag(item.id, 'locked')} className={`p-2 rounded-xl transition-all ${item.is_locked ? 'text-blue-600 bg-blue-100' : 'text-slate-200 hover:text-slate-400'}`}>{item.is_locked ? <Pin size={18} /> : <PinOff size={18} />}</button>
                        </td>
                        <td className="px-6 py-4">
                          <div className="text-slate-800 font-black break-words flex items-center gap-1.5 flex-wrap">
                            {item.name}
                            {item.is_dead_stock && item.is_locked && <span className="bg-orange-100 text-orange-700 text-[9px] px-1.5 py-0.5 rounded font-black shrink-0">キープ・交換希望</span>}
                          </div>
                          <div className="text-[9px] text-slate-400 mt-1">{item.spec}</div>
                        </td>
                        <td className="px-6 py-4 text-right text-base font-black text-slate-800">{(item.stock_total || 0).toLocaleString()} <span className="text-[10px] text-slate-400">{item.unit}</span></td>
                        <td className="px-6 py-4 text-right">
                          {item.is_dead_stock ? (
                            <input
                              type="text"
                              inputMode="decimal"
                              value={item.dead_stock_qty ?? item.stock_total}
                              onChange={(e) => {
                                const converted = e.target.value.replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).replace(/[^0-9.]/g, '');
                                handleQtyChange(item.id, converted, item.stock_total);
                              }}
                              className="w-20 text-right font-black py-1.5 px-2 rounded-lg border-2 border-red-200 bg-red-50 text-red-700 focus:border-red-500 outline-none"
                            />
                          ) : (
                            <span className="text-slate-300">-</span>
                          )}
                        </td>
                        <td className="px-6 py-4"><div className="text-[9px] text-slate-400 font-mono">{item.lot_number}</div><span className={`px-2 py-0.5 rounded text-[10px] font-black ${isExpired ? 'bg-red-100 text-red-600' : 'bg-slate-100 text-slate-600'}`}>{item.expiry_date}</span></td>
                        <td className="px-6 py-4 text-right text-slate-700 font-mono">¥{(item.total_amount || 0).toLocaleString()}</td>
                      </tr>
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>

            {/* スマホ向けカードリスト (md未満で表示) */}
            <div className="md:hidden divide-y divide-slate-100">
              {filteredInventory.map((item, index, array) => {
                const storeName = stores.find(s => s.id === item.store_id)?.name || '不明';
                const isExpired = (item.expiry_date || '9999-12-31') < todayStr;
                const currentCode = item.yakka_code || item.yj_code;
                const isFirstOfMedicine = index === 0 || currentCode !== (array[index-1].yakka_code || array[index-1].yj_code);

                return (
                  <div key={item.id} className="p-4 space-y-3">
                    {/* 一括設定ボタン（不整合修正時のみ） */}
                    {filterCodes && isFirstOfMedicine && (
                      <div className="bg-slate-50 p-2 rounded-xl flex items-center justify-between mb-2">
                         <span className="text-[10px] font-black text-slate-400">一括設定対象</span>
                         <button onClick={() => handleBulkUpdate(currentCode || '')} className="px-3 py-1 bg-blue-600 text-white text-[9px] font-black rounded-lg">一括不動化</button>
                      </div>
                    )}
                    
                    {/* 上段：薬品名とアクション */}
                    <div className="flex justify-between items-start gap-2">
                      <div className="flex-1">
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="bg-slate-100 text-slate-500 text-[9px] px-1.5 py-0.5 rounded flex items-center shrink-0">
                            <StoreIcon size={10} className="mr-1" /> {storeName}
                          </span>
                          {item.is_dead_stock && item.is_locked && <span className="bg-orange-100 text-orange-700 text-[9px] px-1.5 py-0.5 rounded font-black shrink-0">キープ・交換希望</span>}
                          {item.is_dead_stock && !item.is_locked && <span className="bg-red-100 text-red-600 text-[9px] px-1.5 py-0.5 rounded font-black shrink-0">不動在庫</span>}
                          {!item.is_dead_stock && item.is_locked && <span className="bg-blue-100 text-blue-600 text-[9px] px-1.5 py-0.5 rounded font-black shrink-0">キープ</span>}
                        </div>
                        <div className="text-sm font-black text-slate-800 leading-tight">{item.name}</div>
                        <div className="text-[10px] text-slate-400 mt-0.5">{item.spec}</div>
                      </div>
                      <div className="flex flex-col gap-2">
                        <button title={item.is_dead_stock ? '不動在庫の設定を解除' : '不動在庫に設定'} onClick={() => toggleFlag(item.id, 'unneeded')} className={`p-3 rounded-2xl transition-all shadow-sm ${item.is_dead_stock ? 'bg-red-600 text-white shadow-red-200' : 'bg-slate-50 text-slate-300'}`}>
                          <CheckSquare size={20} />
                        </button>
                        <button title={item.is_locked ? 'キープを解除' : 'キープする'} onClick={() => toggleFlag(item.id, 'locked')} className={`p-3 rounded-2xl transition-all shadow-sm ${item.is_locked ? 'bg-blue-600 text-white shadow-blue-200' : 'bg-slate-50 text-slate-300'}`}>
                          {item.is_locked ? <Pin size={18} /> : <PinOff size={18} />}
                        </button>
                      </div>
                    </div>

                    {/* 下段：在庫・期限・金額 */}
                    <div className="grid grid-cols-2 gap-2 bg-slate-50 p-3 rounded-2xl">
                      <div>
                        <div className="text-[9px] text-slate-400 uppercase font-black">在庫数</div>
                        <div className="text-lg font-black text-slate-800 tabular-nums">
                          {(item.stock_total || 0).toLocaleString()} <span className="text-xs text-slate-400">{item.unit}</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[9px] text-slate-400 uppercase font-black">在庫金額</div>
                        <div className="text-sm font-bold text-slate-600 tabular-nums mt-1">
                          ¥{(item.total_amount || 0).toLocaleString()}
                        </div>
                      </div>
                      {item.is_dead_stock && (
                        <div className="col-span-2">
                          <div className="text-[9px] text-slate-400 uppercase font-black mb-1">不要数量</div>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={item.dead_stock_qty ?? item.stock_total}
                            onChange={(e) => {
                              const converted = e.target.value.replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).replace(/[^0-9.]/g, '');
                              handleQtyChange(item.id, converted, item.stock_total);
                            }}
                            className="w-full text-center font-black py-2 rounded-xl border-2 border-red-200 bg-red-50 text-red-700 focus:border-red-500 outline-none"
                          />
                        </div>
                      )}
                      <div className="col-span-2 pt-2 border-t border-slate-200/50 flex items-center justify-between">
                        <div className="text-[9px] text-slate-400 font-mono">{item.lot_number || 'LOT不明'}</div>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-black ${isExpired ? 'bg-red-100 text-red-600' : 'bg-slate-200 text-slate-600'}`}>
                          期限: {item.expiry_date}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="py-40 text-center text-slate-300 uppercase tracking-widest font-black">
            <Package size={64} className="mx-auto mb-4 opacity-10" />
            表示対象の在庫はありません
          </div>
        )}
      </div>
    </div>
  );
};

export default InventoryList;