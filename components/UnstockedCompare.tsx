import React, { useMemo, useState, useEffect, useRef } from 'react';
import { Download, Search, Printer, ArrowUpDown, ArrowUp, ArrowDown, Save, Loader2, Check } from 'lucide-react';
import { InventoryItem, Store } from '../types';
import { supabase } from '../supabase';

type Props = {
  inventory: InventoryItem[];
  stores: Store[];
  currentStoreId: string;
  onRefresh?: () => void | Promise<void>;
};

type SortKey = 'type' | 'store' | 'name' | 'stock' | 'requestQty' | 'unit' | 'expiry';
type SortOrder = 'asc' | 'desc';

const UnstockedCompare: React.FC<Props> = ({ inventory, stores, currentStoreId, onRefresh }) => {
  const [selectedStore, setSelectedStore] = useState<string>('all');
  const [query, setQuery] = useState<string>('');
  const [includeOwnKeep, setIncludeOwnKeep] = useState<boolean>(false);

  // ソート状態管理
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

  // 必要・希望数量の編集状態を管理 (キー: item.id, 値: 入力数値文字列)
  const [requestQuantities, setRequestQuantities] = useState<Record<string, string>>({});
  const [isBulkSaving, setIsBulkSaving] = useState<boolean>(false);
  const [saveSuccessMessage, setSaveSuccessMessage] = useState<boolean>(false);

  // 最新の requestQuantities を ref で参照
  const requestQuantitiesRef = useRef(requestQuantities);
  useEffect(() => {
    requestQuantitiesRef.current = requestQuantities;
  }, [requestQuantities]);

  // DBからのデータ読み込み時にStateを初期化・同期
  useEffect(() => {
    const loadedQtys: Record<string, string> = {};
    inventory.forEach(item => {
      const saved = (item.unstocked_request_amounts as Record<string, number>)?.[currentStoreId];
      const savedStr = (saved !== undefined && saved !== null) ? String(saved) : '';

      if (requestQuantitiesRef.current[item.id] !== undefined) {
        loadedQtys[item.id] = requestQuantitiesRef.current[item.id];
      } else if (savedStr !== '') {
        loadedQtys[item.id] = savedStr;
      }
    });

    setRequestQuantities(loadedQtys);
  }, [inventory, currentStoreId]);

  // 自店で stock_total > 0 の医薬品コード集合
  const ownCodes = useMemo(() => {
    const s = new Set<string>();
    inventory.forEach(it => {
      if (it.store_id === currentStoreId && (it.stock_total || 0) > 0) {
        const code = it.yakka_code || it.yj_code;
        if (code) s.add(code);
      }
    });
    return s;
  }, [inventory, currentStoreId]);

  // 指定の他店舗で在庫が存在する医薬品コード集合
  const targetOtherStoreCodes = useMemo(() => {
    const s = new Set<string>();
    inventory.forEach(it => {
      if (it.store_id === currentStoreId) return;
      if ((it.stock_total || 0) <= 0) return;
      if (selectedStore !== 'all' && it.store_id !== selectedStore) return;
      
      const code = it.yakka_code || it.yj_code || it.name;
      if (code) s.add(code);
    });
    return s;
  }, [inventory, currentStoreId, selectedStore]);

  // 他店舗で在庫を持ち、かつ自店に在庫がない品目を抽出
  const otherStoreItems = useMemo(() => {
    return inventory.filter(it => {
      if (it.store_id === currentStoreId) return false;
      if ((it.stock_total || 0) <= 0) return false;
      const code = it.yakka_code || it.yj_code || '';
      if (ownCodes.has(code)) return false;
      if (selectedStore !== 'all' && it.store_id !== selectedStore) return false;
      
      if (query) {
        const q = query.toLowerCase();
        return (
          (it.name || '').toLowerCase().includes(q) ||
          (it.spec || '').toLowerCase().includes(q) ||
          (code || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [inventory, currentStoreId, ownCodes, selectedStore, query]);

  // 自店の交換希望品（キープ品）
  const ownKeepItems = useMemo(() => {
    if (!includeOwnKeep) return [] as InventoryItem[];
    return inventory.filter(it => {
      if (it.store_id !== currentStoreId) return false;
      if (!it.is_dead_stock || !it.is_locked || !it.name) return false;
      
      const code = it.yakka_code || it.yj_code || it.name;
      if (!targetOtherStoreCodes.has(code)) return false;

      if (query) {
        const q = query.toLowerCase();
        return (
          (it.name || '').toLowerCase().includes(q) ||
          (it.spec || '').toLowerCase().includes(q) ||
          (code || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [inventory, currentStoreId, includeOwnKeep, targetOtherStoreCodes, query]);

  // 抽出結果の結合
  const combined = useMemo(() => {
    const other = otherStoreItems.map(it => ({ type: '他店保有品' as const, item: it }));
    const own = ownKeepItems.map(it => ({ type: '自店交換希望' as const, item: it }));
    return [...other, ...own];
  }, [otherStoreItems, ownKeepItems]);

  const handleQuantityChange = (id: string, value: string) => {
    setRequestQuantities(prev => ({
      ...prev,
      [id]: value
    }));
  };

  const dirtyItems = useMemo(() => {
    return combined.filter(entry => {
      const savedQty = Number((entry.item.unstocked_request_amounts as Record<string, number>)?.[currentStoreId] ?? 0);
      const inputValStr = requestQuantities[entry.item.id];
      if (inputValStr === undefined) return false;
      
      const currentQty = inputValStr === '' ? 0 : Number(inputValStr);
      return !isNaN(currentQty) && currentQty !== savedQty;
    });
  }, [combined, requestQuantities, currentStoreId]);

  const handleBulkSave = async () => {
    if (dirtyItems.length === 0) return;

    setIsBulkSaving(true);
    try {
      const updates = dirtyItems.map(async entry => {
        const item = entry.item;
        const inputValStr = requestQuantities[item.id] || '0';
        const newQty = Number(inputValStr);

        const currentAmounts = (item.unstocked_request_amounts && typeof item.unstocked_request_amounts === 'object')
          ? { ...(item.unstocked_request_amounts as Record<string, number>) }
          : {};

        const updatedAmounts = {
          ...currentAmounts,
          [currentStoreId]: newQty
        };

        const { data, error } = await supabase
          .from('inventory_items')
          .update({ 
            unstocked_request_amounts: updatedAmounts,
            updated_at: new Date().toISOString()
          })
          .eq('id', item.id)
          .select();

        return { data, error, item, newQty, updatedAmounts };
      });

      const results = await Promise.all(updates);

      let hasError = false;
      results.forEach(r => {
        if (r.error || !r.data || r.data.length === 0) {
          hasError = true;
        }
      });

      if (hasError) {
        throw new Error('一部またはすべてのデータの保存に失敗しました。');
      }

      setRequestQuantities(prev => {
        const next = { ...prev };
        results.forEach(({ item, newQty, updatedAmounts }) => {
          item.unstocked_request_amounts = updatedAmounts;
          next[item.id] = String(newQty);
        });
        return next;
      });

      setSaveSuccessMessage(true);
      setTimeout(() => setSaveSuccessMessage(false), 2000);

      if (onRefresh) {
        await onRefresh();
      }
    } catch (err: any) {
      console.error('Failed to bulk save quantities:', err);
      alert(err.message || '保存処理中にエラーが発生しました。');
    } finally {
      setIsBulkSaving(false);
    }
  };

  const sortedCombined = useMemo(() => {
    const list = [...combined];
    list.sort((a, b) => {
      const storeA = stores.find(s => s.id === a.item.store_id)?.name || '';
      const storeB = stores.find(s => s.id === b.item.store_id)?.name || '';
      const unitStrA = `${a.item.spec || ''} ${a.item.unit || ''}`.trim();
      const unitStrB = `${b.item.spec || ''} ${b.item.unit || ''}`.trim();

      const savedQtyA = (a.item.unstocked_request_amounts as Record<string, number>)?.[currentStoreId] ?? 0;
      const savedQtyB = (b.item.unstocked_request_amounts as Record<string, number>)?.[currentStoreId] ?? 0;

      const qtyA = Number(requestQuantities[a.item.id] ?? savedQtyA);
      const qtyB = Number(requestQuantities[b.item.id] ?? savedQtyB);

      let valA: string | number = '';
      let valB: string | number = '';

      switch (sortKey) {
        case 'type':
          valA = a.type;
          valB = b.type;
          break;
        case 'store':
          valA = storeA;
          valB = storeB;
          break;
        case 'name':
          valA = a.item.name || '';
          valB = b.item.name || '';
          break;
        case 'stock':
          valA = a.item.stock_total || 0;
          valB = b.item.stock_total || 0;
          break;
        case 'requestQty':
          valA = qtyA;
          valB = qtyB;
          break;
        case 'unit':
          valA = unitStrA;
          valB = unitStrB;
          break;
        case 'expiry':
          valA = a.item.expiry_date || '';
          valB = b.item.expiry_date || '';
          break;
      }

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });
    return list;
  }, [combined, sortKey, sortOrder, stores, requestQuantities, currentStoreId]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortOrder('asc');
    }
  };

  const handleDownloadCsv = () => {
    const headers = ['種別', '店舗', '薬品名', '在庫数', '必要/希望数', '規格単位', '期限'];
    const rows = sortedCombined.map(entry => {
      const s = stores.find(st => st.id === entry.item.store_id);
      const unitStr = `${entry.item.spec || ''} ${entry.item.unit || ''}`.trim();
      const savedQty = (entry.item.unstocked_request_amounts as Record<string, number>)?.[currentStoreId] ?? 0;
      const currentQty = requestQuantities[entry.item.id] ?? savedQty;

      return [
        entry.type,
        s?.name || entry.item.store_id,
        entry.item.name || '',
        String(entry.item.stock_total || 0),
        String(currentQty),
        unitStr,
        entry.item.expiry_date || ''
      ];
    });

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `分譲比較リスト_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // 【新・印刷用関数】必要/希望数が入力されている項目のみを抽出し、独立したウィンドウで印刷展開する
  const handlePrint = () => {
    const printItems = sortedCombined.filter(entry => {
      const savedQty = Number((entry.item.unstocked_request_amounts as Record<string, number>)?.[currentStoreId] ?? 0);
      const displayQty = requestQuantities[entry.item.id] ?? (savedQty === 0 ? '' : String(savedQty));
      const currentNum = displayQty === '' ? 0 : Number(displayQty);
      return !isNaN(currentNum) && currentNum > 0;
    });

    if (printItems.length === 0) {
      alert('必要/希望数が入力されている薬品がありません。');
      return;
    }

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('ポップアップがブロックされました。印刷を許可してください。');
      return;
    }

    const dateStr = new Date().toLocaleDateString('ja-JP');

    const rowsHtml = printItems.map(entry => {
      const s = stores.find(st => st.id === entry.item.store_id);
      const unitStr = `${entry.item.spec || ''} ${entry.item.unit || ''}`.trim() || '-';
      const savedQty = Number((entry.item.unstocked_request_amounts as Record<string, number>)?.[currentStoreId] ?? 0);
      const displayQty = requestQuantities[entry.item.id] ?? String(savedQty);

      return `
        <tr>
          <td>${entry.type}</td>
          <td>${s?.name || entry.item.store_id}</td>
          <td><strong>${entry.item.name || ''}</strong></td>
          <td style="text-align: right;">${(entry.item.stock_total || 0).toLocaleString()}</td>
          <td style="text-align: right; font-weight: bold;">${Number(displayQty).toLocaleString()}</td>
          <td>${unitStr}</td>
          <td>${entry.item.expiry_date || '-'}</td>
        </tr>
      `;
    }).join('');

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>他店有・自店無 在庫比較・分譲依頼リスト</title>
        <style>
          body { font-family: sans-serif; font-size: 12px; margin: 20px; color: #1e293b; }
          .header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #0f172a; padding-bottom: 4px; margin-bottom: 12px; }
          .title { font-size: 16px; font-weight: bold; }
          .date { font-size: 10px; color: #64748b; }
          table { width: 100%; border-collapse: collapse; margin-top: 8px; }
          th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; }
          th { background-color: #f8fafc; font-weight: bold; }
          tr { break-inside: avoid; }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="title">他店有・自店無 在庫比較・分譲依頼リスト</div>
          <div class="date">出力日: ${dateStr}</div>
        </div>
        <table>
          <thead>
            <tr>
              <th>種別</th>
              <th>店舗</th>
              <th>薬品名</th>
              <th style="text-align: right;">在庫数</th>
              <th style="text-align: right;">必要/希望数</th>
              <th>規格単位</th>
              <th>期限</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </body>
      </html>
    `;

    printWindow.document.open();
    printWindow.document.write(htmlContent);
    printWindow.document.close();

    // 読み込み完了後に印刷実行＆自動クローズ
    printWindow.onload = () => {
      printWindow.focus();
      printWindow.print();
      printWindow.close();
    };
  };

  const renderSortIcon = (key: SortKey) => {
    if (sortKey !== key) return <ArrowUpDown size={14} className="ml-1 text-slate-300 inline" />;
    return sortOrder === 'asc' 
      ? <ArrowUp size={14} className="ml-1 text-blue-600 inline" />
      : <ArrowDown size={14} className="ml-1 text-blue-600 inline" />;
  };

  return (
    <div className="w-full flex flex-col h-[calc(100vh-120px)] p-4">
      {/* ツールバー */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4 shrink-0">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center bg-white rounded-3xl px-3 py-2 shadow-sm border border-slate-200">
            <Search size={16} className="text-slate-400" />
            <input 
              value={query} 
              onChange={e => setQuery(e.target.value)} 
              placeholder="薬品名・規格で検索" 
              className="ml-2 outline-none text-sm w-64 bg-transparent" 
            />
          </div>

          <div className="bg-white rounded-3xl px-3 py-2 shadow-sm border border-slate-200">
            <select 
              value={selectedStore} 
              onChange={e => setSelectedStore(e.target.value)} 
              className="bg-transparent outline-none text-sm font-bold text-slate-700"
            >
              <option value="all">全他店舗</option>
              {stores.filter(s => s.id !== currentStoreId).map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          <label className="flex items-center space-x-2 text-sm cursor-pointer select-none">
            <input 
              type="checkbox" 
              checked={includeOwnKeep} 
              onChange={e => setIncludeOwnKeep(e.target.checked)} 
              className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500" 
            />
            <span className="text-slate-700 font-bold">自店の交換希望（キープ品）を含めて統合出力</span>
          </label>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={handleBulkSave}
            disabled={isBulkSaving || dirtyItems.length === 0}
            className={`flex items-center space-x-2 px-4 py-2 rounded-3xl shadow transition-colors font-bold text-sm ${
              saveSuccessMessage
                ? 'bg-emerald-600 text-white'
                : dirtyItems.length > 0
                ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed'
            }`}
          >
            {isBulkSaving ? (
              <Loader2 size={16} className="animate-spin" />
            ) : saveSuccessMessage ? (
              <Check size={16} />
            ) : (
              <Save size={16} />
            )}
            <span>
              {saveSuccessMessage
                ? '保存完了'
                : dirtyItems.length > 0
                ? `変更を保存 (${dirtyItems.length})`
                : '一括保存'}
            </span>
          </button>

          <button 
            onClick={handlePrint} 
            className="flex items-center space-x-2 bg-slate-700 text-white px-4 py-2 rounded-3xl shadow hover:bg-slate-800 transition-colors"
          >
            <Printer size={16} />
            <span className="font-bold text-sm">印刷 / PDF出力</span>
          </button>

          <button 
            onClick={handleDownloadCsv} 
            className="flex items-center space-x-2 bg-blue-600 text-white px-4 py-2 rounded-3xl shadow hover:bg-blue-700 transition-colors"
          >
            <Download size={16} />
            <span className="font-bold text-sm">新規分譲用CSV</span>
          </button>
        </div>
      </div>

      {/* テーブルエリア */}
      <div className="flex-1 min-h-0 bg-white rounded-lg shadow-sm border border-slate-200 overflow-y-auto">
        <table className="min-w-full text-sm border-collapse">
          <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 shadow-sm z-10">
            <tr className="text-slate-600 text-left">
              <th onClick={() => handleSort('type')} className="px-3 py-2 cursor-pointer select-none hover:bg-slate-100 font-bold bg-slate-50">
                種別 {renderSortIcon('type')}
              </th>
              <th onClick={() => handleSort('store')} className="px-3 py-2 cursor-pointer select-none hover:bg-slate-100 font-bold bg-slate-50">
                店舗 {renderSortIcon('store')}
              </th>
              <th onClick={() => handleSort('name')} className="px-3 py-2 cursor-pointer select-none hover:bg-slate-100 font-bold bg-slate-50">
                薬品名 {renderSortIcon('name')}
              </th>
              <th onClick={() => handleSort('stock')} className="px-3 py-2 text-right cursor-pointer select-none hover:bg-slate-100 font-bold bg-slate-50">
                在庫数 {renderSortIcon('stock')}
              </th>
              <th onClick={() => handleSort('requestQty')} className="px-3 py-2 text-right cursor-pointer select-none hover:bg-slate-100 font-bold w-32 bg-slate-50">
                必要/希望数 {renderSortIcon('requestQty')}
              </th>
              <th onClick={() => handleSort('unit')} className="px-3 py-2 cursor-pointer select-none hover:bg-slate-100 font-bold bg-slate-50">
                規格単位 {renderSortIcon('unit')}
              </th>
              <th onClick={() => handleSort('expiry')} className="px-3 py-2 cursor-pointer select-none hover:bg-slate-100 font-bold bg-slate-50">
                期限 {renderSortIcon('expiry')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sortedCombined.map((entry, idx) => {
              const s = stores.find(st => st.id === entry.item.store_id);
              const unitStr = `${entry.item.spec || ''} ${entry.item.unit || ''}`.trim() || '-';
              const isOwnKeep = entry.type === '自店交換希望';
              
              const savedQty = Number((entry.item.unstocked_request_amounts as Record<string, number>)?.[currentStoreId] ?? 0);
              const displayQty = requestQuantities[entry.item.id] ?? (savedQty === 0 ? '' : String(savedQty));
              
              const currentNum = displayQty === '' ? 0 : Number(displayQty);
              const isDirty = !isNaN(currentNum) && currentNum !== savedQty;

              return (
                <tr key={`${entry.item.id}-${idx}`} className="hover:bg-slate-50 border-b border-slate-100">
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                      isOwnKeep 
                        ? 'bg-orange-100 text-orange-700' 
                        : 'bg-blue-100 text-blue-700'
                    }`}>
                      {entry.type}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-bold text-slate-700">{s?.name || entry.item.store_id}</td>
                  <td className="px-3 py-2 font-bold text-slate-900">{entry.item.name}</td>
                  <td className="px-3 py-2 text-right font-mono font-bold text-slate-800">
                    {(entry.item.stock_total || 0).toLocaleString()}
                  </td>
                  <td className="px-3 py-1 text-right">
                    <div className="inline-flex items-center justify-end space-x-1 w-full">
                      <input 
                        type="text" 
                        inputMode="decimal"
                        value={displayQty} 
                        onChange={e => {
                          const converted = e.target.value.replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).replace(/[^0-9.]/g, '');
                          handleQuantityChange(entry.item.id, converted);
                        }}
                        className={`w-20 text-right font-mono font-bold px-2 py-1 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                          isDirty 
                            ? 'bg-amber-50 border-amber-400 text-amber-900' 
                            : 'bg-slate-50 border-slate-300'
                        }`}
                        placeholder="0"
                      />
                      {isDirty && (
                        <span className="text-[10px] bg-amber-200 text-amber-800 font-bold px-1 rounded">
                          未
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{unitStr}</td>
                  <td className="px-3 py-2 font-mono text-slate-600">{entry.item.expiry_date || '-'}</td>
                </tr>
              );
            })}
            {sortedCombined.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-slate-400 font-bold">
                  該当する医薬品は見つかりませんでした。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default UnstockedCompare;