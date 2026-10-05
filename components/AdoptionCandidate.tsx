import React, { useMemo } from 'react';
import { Globe, CheckCircle2, Circle, AlertCircle } from 'lucide-react';
import { InventoryItem, Store } from '../types';

interface AdoptionCandidateProps {
  inventory: InventoryItem[];
  onUpdateItem: (id: string, patch: Partial<InventoryItem>) => void;
  currentStoreId: string;
  stores: Store[];
}

const AdoptionCandidate: React.FC<AdoptionCandidateProps> = ({
  inventory,
  onUpdateItem,
  currentStoreId,
  stores
}) => {
  // 1. 自店の在庫リストを抽出（採用済み判定用）
  const myInventoryNames = useMemo(() => {
    return new Set(
      inventory
        .filter(item => item.store_id === currentStoreId)
        .map(item => item.name)
    );
  }, [inventory, currentStoreId]);

  // 2. 他店のデッドストックを「採用済み」と「未採用」に分ける
  const categorizedList = useMemo(() => {
    const othersDeadStock = inventory.filter(item => 
      item.store_id !== currentStoreId && 
      item.is_dead_stock === true
    );

  // 自店の在庫状況を詳しくマッピング（名前 -> 在庫アイテムのペア）
  const myInventoryMap = new Map<string, InventoryItem>(
    inventory
      .filter(item => item.store_id === currentStoreId)
      .map(item => [item.name, item])
  );

    return {
    // 1. 自店で採用しており、かつ「不要フラグが立っていない」もの
    hasInStock: othersDeadStock.filter(item => {
      const myItem = myInventoryMap.get(item.name);
      return myItem &&  !(myItem as InventoryItem).is_dead_stock;
    }),
    // 2. 自店でも「不要フラグ（is_dead_stock）」を立てているもの（要注意！）
    bothDeadStock: othersDeadStock.filter(item => {
      const myItem = myInventoryMap.get(item.name);
      return myItem &&  (myItem as InventoryItem).is_dead_stock;
    }),
    // 3. 自店に在庫データ自体が存在しないもの
    notInStock: othersDeadStock.filter(item => !myInventoryMap.has(item.name)),

      totalCount: othersDeadStock.length
    };
  }, [inventory, currentStoreId]);

    const [sortConfig, setSortConfig] = React.useState<{ key: keyof InventoryItem, direction: 'asc' | 'desc' } | null>(null);

  const sortedList = (list: InventoryItem[]) => {
    if (!sortConfig) return list;
    return [...list].sort((a, b) => {
      const aValue = a[sortConfig.key] ?? '';
      const bValue = b[sortConfig.key] ?? '';
      if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  };

  // ヘッダーのクリックハンドラ
  const requestSort = (key: keyof InventoryItem) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  // 3. 引受希望を出している店舗の中から、回転率に基づき第一候補を判定するロジック
  const getBestAdopterId = (item: InventoryItem): string | null => {
    const adopters = item.adopting_store_ids || [];
    if (adopters.length === 0) return null;
    if (adopters.length === 1) return adopters[0];

    // 希望が複数の場合、引受側の「在庫データ」を参照してスコアリング
    const candidateStats = adopters.map(storeId => {
      // 引受候補店の同名薬の在庫状況を取得（回転率の代理指標）
      const storeInv = inventory.filter(i => i.store_id === storeId && (i.yakka_code === item.yakka_code || i.name === item.name));
      const totalStock = storeInv.reduce((sum, i) => sum + i.stock_total, 0);
      const latestExpiry = storeInv.length > 0 ? storeInv.sort((a, b) => b.expiry_date.localeCompare(a.expiry_date))[0].expiry_date : '0000-00-00';
      
      return { storeId, totalStock, latestExpiry };
    });

    // 1. 在庫数が多い順（回転している） 2. 期限が新しい順（アクティブな採用）でソート
    return candidateStats.sort((a, b) => {
      if (b.totalStock !== a.totalStock) return b.totalStock - a.totalStock;
      return b.latestExpiry.localeCompare(a.latestExpiry);
    })[0].storeId;
  };

    // --- 数量更新ロジック ---
  const handleAmountChange = (itemId: string, value: string, max: number) => {
    let num = parseFloat(value);
    if (isNaN(num) || num < 0) num = 0;
    if (num > max) num = max;

    const item = inventory.find(i => i.id === itemId);
    if (!item) return;

    const currentRequests = item.requested_amounts || {};
    const currentAdopters = item.adopting_store_ids || [];

    const isNowAdopting = num > 0;
    const updatedAdopters = isNowAdopting
      ? Array.from(new Set([...currentAdopters, currentStoreId]))
      : currentAdopters.filter(id => id !== currentStoreId);

    onUpdateItem(itemId, {
      requested_amounts: { ...currentRequests, [currentStoreId]: num },
      adopting_store_ids: updatedAdopters
    });
  };

  // --- トグルロジックの変更（数値ベース） ---
  const toggleAdoption = (item: InventoryItem) => {
    const available = item.dead_stock_qty ?? item.stock_total;
    const requestedAmount = item.requested_amounts?.[currentStoreId] || 0;
    const nextAmount = requestedAmount > 0 ? '0' : available.toString();
    handleAmountChange(item.id, nextAmount, available);
  };

  // 5. テーブル描画用の共通部品
  const renderTable = (list: InventoryItem[], emptyMessage: string) => {
    if (list.length === 0) {
      return (
        <div className="p-8 text-center bg-white/50 rounded-3xl border border-dashed border-slate-200 text-slate-400 font-bold">
          {emptyMessage}
        </div>
      );
    }

  const currentList = sortedList(list);

    return (
      <>
        {/* PC用：テーブル形式 (md以上) */}
        <div className="hidden md:block bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden">
          <table className="w-full text-left border-separate border-spacing-0">
            <thead>
              <tr className="bg-slate-50">
                <th className="p-4 text-[11px] font-black text-slate-400 uppercase border-b border-slate-100">供出元</th>
                <th className="p-4 text-[11px] font-black text-slate-400 uppercase border-b border-slate-100 cursor-pointer hover:bg-slate-100" onClick={() => setSortConfig({ key: 'name', direction: sortConfig?.direction === 'asc' ? 'desc' : 'asc' })}>薬品名 / 規格</th>
                <th className="p-4 text-[11px] font-black text-slate-400 uppercase text-center border-b border-slate-100">期限</th>
                <th className="p-4 text-[11px] font-black text-slate-400 uppercase text-right border-b border-slate-100">在庫数</th>
                <th className="p-4 text-[11px] font-black text-blue-600 uppercase text-center bg-blue-50/50 border-b border-blue-100">引受希望数</th>
                <th className="p-4 text-[11px] font-black text-slate-400 uppercase text-center border-b border-slate-100">状態</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {currentList.map(item => {
                const sourceStore = stores.find(s => s.id === item.store_id);
                const requestedAmount = item.requested_amounts?.[currentStoreId] || 0;
                const isMyChoice = requestedAmount > 0;
                const bestAdopterId = getBestAdopterId(item);
                const isFirstCandidate = isMyChoice && bestAdopterId === currentStoreId;
                const isCompeted = isMyChoice && bestAdopterId !== currentStoreId;
                const otherAdoptersCount = (item.adopting_store_ids?.length || 0) - (isMyChoice ? 1 : 0);

                return (
                  <tr key={item.id} className={`hover:bg-blue-50/30 transition-colors ${isMyChoice ? 'bg-blue-50/50' : ''}`}>
                    <td className="p-4">
                      <span className="px-2 py-1 bg-slate-100 text-slate-600 rounded-lg text-[10px] font-bold">{sourceStore?.name || '不明'}</span>
                    </td>
                    <td className="p-4">
                      <div className="font-bold text-slate-800 flex items-center gap-1.5 flex-wrap">
                        {item.name}
                        {item.is_locked && (
                          <span className="bg-amber-100 text-amber-700 text-[9px] px-1.5 py-0.5 rounded font-black shrink-0">交換希望</span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-400">{item.spec}</div>
                    </td>
                    <td className="p-4 text-center text-[11px] font-black text-slate-600">{item.expiry_date}</td>
                    <td className="p-4 text-right font-black text-slate-700">
                      {(item.dead_stock_qty ?? item.stock_total)} <small>{item.unit}</small>
                      {(item.dead_stock_qty ?? item.stock_total) !== item.stock_total && (
                        <div className="text-[9px] text-slate-400 font-normal">在庫全体: {item.stock_total}{item.unit}</div>
                      )}
                    </td>
                    <td className="p-4 bg-blue-50/20 text-center">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        max={item.dead_stock_qty ?? item.stock_total}
                        value={requestedAmount || ''}
                        onChange={(e) => handleAmountChange(item.id, e.target.value, item.dead_stock_qty ?? item.stock_total)}
                        className="w-20 text-center font-black py-2 rounded-xl border-2 border-slate-200 focus:border-blue-500 outline-none"
                      />
                    </td>
                    <td className="p-4">
                      <div className="flex flex-col items-center gap-1">
                        <button onClick={() => toggleAdoption(item)} className={`p-2 rounded-xl transition-all ${isFirstCandidate ? 'bg-blue-600 text-white shadow-lg' : 'bg-white text-slate-300 border border-slate-200'}`}>
                          {isMyChoice ? <CheckCircle2 size={24} /> : <Circle size={24} />}
                        </button>
                        {isFirstCandidate && <span className="text-[8px] font-black text-blue-600">第一候補</span>}
                        {isCompeted && <span className="text-[8px] font-black text-slate-500">他店優先</span>}
                        {otherAdoptersCount > 0 && <span className="text-[9px] font-bold text-amber-600">他 {otherAdoptersCount} 店希望</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* スマホ用：カード形式 (md未満) */}
        <div className="md:hidden space-y-3">
          {currentList.map(item => {
            const sourceStore = stores.find(s => s.id === item.store_id);
            const requestedAmount = item.requested_amounts?.[currentStoreId] || 0;
            const isMyChoice = requestedAmount > 0;
            const bestAdopterId = getBestAdopterId(item);
            const isFirstCandidate = isMyChoice && bestAdopterId === currentStoreId;
            const otherAdoptersCount = (item.adopting_store_ids?.length || 0) - (isMyChoice ? 1 : 0);

            return (
              <div key={item.id} className={`bg-white p-4 rounded-2xl border ${isMyChoice ? 'border-blue-200 shadow-blue-50' : 'border-slate-100'} shadow-sm`}>
                <div className="flex justify-between items-start mb-2">
                  <span className="px-2 py-0.5 bg-slate-100 text-slate-500 rounded text-[10px] font-black">{sourceStore?.name || '不明'}</span>
                  <span className="text-[10px] font-mono font-bold text-slate-400">{item.expiry_date}</span>
                </div>
                <div className="font-bold text-slate-800 leading-tight mb-1 flex items-center gap-1.5 flex-wrap">
                  {item.name}
                  {item.is_locked && (
                    <span className="bg-amber-100 text-amber-700 text-[9px] px-1.5 py-0.5 rounded font-black shrink-0">交換希望</span>
                  )}
                </div>
                <div className="text-[11px] text-slate-400 mb-4">{item.spec}</div>
                
                <div className="flex items-center justify-between gap-4 pt-3 border-t border-slate-50">
                  <div className="flex-1">
                    <div className="text-[9px] font-black text-slate-400 uppercase mb-1">引受希望 ({item.unit})</div>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        inputMode="decimal"
                        step="any"
                        min="0"
                        max={item.dead_stock_qty ?? item.stock_total}
                        value={requestedAmount || ''}
                        placeholder={`max ${item.dead_stock_qty ?? item.stock_total}`}
                        onChange={(e) => handleAmountChange(item.id, e.target.value, item.dead_stock_qty ?? item.stock_total)}
                        className={`w-full text-center font-black py-2 rounded-xl border-2 transition-all ${isMyChoice ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-100 bg-slate-50 text-slate-400'}`}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col items-center">
                    <button onClick={() => toggleAdoption(item)} className={`p-3 rounded-2xl transition-all active:scale-90 ${isFirstCandidate ? 'bg-blue-600 text-white shadow-lg' : 'bg-slate-100 text-slate-300'}`}>
                      <CheckCircle2 size={28} />
                    </button>
                    {otherAdoptersCount > 0 && <span className="text-[8px] font-bold text-amber-600 mt-1">他{otherAdoptersCount}店希望</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </>
    );
  };

  return (
    <div className="flex flex-col h-full space-y-4 md:space-y-6">
      {/* Header：スマホではコンパクトに */}
      <div className="flex items-center justify-between px-1 md:px-0">
        <div>
          <h2 className="text-xl md:text-2xl font-black text-slate-800 flex items-center gap-2">
            <Globe className="text-blue-500" size={24} /> 引受検討
          </h2>
          <p className="hidden md:block text-slate-500 font-medium">自店の採用状況に応じて自動分類されています</p>
        </div>
        <div className="bg-white px-3 py-1.5 md:px-4 md:py-2 rounded-xl md:rounded-2xl shadow-sm border border-slate-100 text-right">
          <span className="text-[9px] md:text-[10px] font-black text-slate-400 uppercase block">対象数</span>
          <span className="text-lg md:text-xl font-black text-blue-600">{categorizedList.totalCount}</span>
        </div>
      </div>

      <div className="bg-amber-50 border-2 border-amber-200 px-4 py-3 rounded-2xl flex items-center gap-3 text-amber-800">
        <span className="bg-amber-100 text-amber-700 text-[10px] px-2 py-1 rounded font-black shrink-0">交換希望</span>
        <p className="text-[11px] md:text-xs font-bold leading-relaxed">
        「引き続き在庫しておきたいが、期限が近いので新しいロットと交換したい」と希望しているもの。可能であれば新しい期限の品と交換。
        </p>
      </div>

      <div className="flex-1 overflow-y-auto space-y-6 md:space-y-8 pr-1">
        {/* セクションごとにPC/スマホ両方の表示を内包したrenderTableを呼び出す */}
        <section>
          <div className="flex items-center gap-2 mb-3 md:mb-4 px-1">
            <div className="w-1.5 h-4 md:h-5 bg-blue-600 rounded-full"></div>
            <h3 className="font-black text-sm md:text-base text-slate-700">自店で採用済み</h3>
            <span className="text-[9px] font-black px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded">補充推奨</span>
          </div>
          {renderTable(categorizedList.hasInStock, "採用済みの薬品に供出はありません")}
        </section>

        {categorizedList.bothDeadStock.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-3 md:mb-4 px-1">
              <div className="w-1.5 h-4 md:h-5 bg-rose-500 rounded-full"></div>
              <h3 className="font-black text-sm md:text-base text-rose-600">自店でも不要</h3>
              <div className="flex items-center gap-1 text-[9px] font-black px-1.5 py-0.5 bg-rose-50 text-rose-600 rounded animate-pulse">
                <AlertCircle size={10} /> <span>注意</span>
              </div>
            </div>
            {renderTable(categorizedList.bothDeadStock, "")}
          </section>
        )}

        <section className="pb-10">
          <div className="flex items-center gap-2 mb-3 md:mb-4 px-1">
            <div className="w-1.5 h-4 md:h-5 bg-slate-400 rounded-full"></div>
            <h3 className="font-black text-sm md:text-base text-slate-500">自店で未採用</h3>
          </div>
          {renderTable(categorizedList.notInStock, "未採用の薬品に供出はありません")}
        </section>
      </div>
    </div>
  );
};

export default AdoptionCandidate;