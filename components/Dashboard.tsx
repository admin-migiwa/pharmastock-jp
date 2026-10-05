
  import React, { useMemo } from 'react';
  import { InventoryItem, Store, ViewType } from '../types';
  // Added ChevronRight to the imports from lucide-react
  import { Package, AlertTriangle, Clock, Trash2, Globe, ChevronRight } from 'lucide-react';

  interface Props {
    inventory: InventoryItem[];
    currentStoreId: string;
    stores: Store[];
    onNavigate: (view: ViewType) => void;
    onJumpToFilter: (codes: string[]) => void;
  }

  const Dashboard: React.FC<Props> = ({ inventory, currentStoreId, stores, onJumpToFilter }) => {
    const filteredInventory = useMemo(() => 
      inventory.filter(i => i.store_id === currentStoreId), 
      [inventory, currentStoreId]
    );

    // --- 2. 不整合（フラグ混在）を検知するロジック ---
    const inconsistentCodes = useMemo(() => {
      // 薬品コード（yakka_code）ごとにグループ化
      const groups: Record<string, InventoryItem[]> = {};
      filteredInventory.forEach(item => {
        const code = item.yakka_code || item.name;
        if (!code) return;
        const groupKey = `${item.store_id}_${code}`; 
        if (!groups[groupKey]) groups[groupKey] = [];
        groups[groupKey].push(item);
      });

      // フラグが混在（trueとfalseが両方存在）しているグループのコードを抽出
      const codesWithInconsistency = Object.values(groups)
        .filter(items => {
        const hasDead = items.some(i => i.is_dead_stock);
        const hasActive = items.some(i => !i.is_dead_stock);
        return hasDead && hasActive;
      })
    .map(items => items[0].yakka_code || items[0].name);

      return Array.from(new Set(codesWithInconsistency));
    }, [filteredInventory]);

    const stats = useMemo(() => {
      const today = new Date();
      const sixMonthsLater = new Date();
      sixMonthsLater.setMonth(today.getMonth() + 6);
      const todayStr = today.toISOString().split('T')[0];
      const sixMonthsStr = sixMonthsLater.toISOString().split('T')[0];

      const total = { count: filteredInventory.length, amount: 0 };
      const expired = { count: 0, amount: 0 };
      const expiringSoon = { count: 0, amount: 0 };
      const unneeded = { count: 0, amount: 0 };

      filteredInventory.forEach(item => {
        // total_amount may be null/undefined or even a string from Supabase
        const amt = Number(item.total_amount) || 0;
        total.amount += amt;
        if (item.expiry_date < todayStr) {
          expired.count++;
          expired.amount += amt;
        } else if (item.expiry_date < sixMonthsStr) {
          expiringSoon.count++;
          expiringSoon.amount += amt;
        }
        if (item.is_dead_stock) {
          unneeded.count++;
          // 不要数量が指定されていれば、その分だけ按分した金額を集計する
          const deadQty = item.dead_stock_qty ?? item.stock_total;
          const deadAmt = item.stock_total > 0 ? (amt * deadQty) / item.stock_total : 0;
          unneeded.amount += deadAmt;
        }
      });

      return { total, expired, expiringSoon, unneeded };
    }, [filteredInventory]);

    return (
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="flex items-center justify-between">
         <div className="flex items-center space-x-2">
           <h1 className="text-xl font-black text-slate-800">
             {`${stores.find(s=>s.id===currentStoreId)?.name || '不明な店舗'} 棚卸時点の概況`}
           </h1>
           {currentStoreId === 'all' && <Globe size={18} className="text-blue-500" />}
         </div>
        </div>

        {inconsistentCodes.length > 0 && (
          <button 
            onClick={() => onJumpToFilter(inconsistentCodes)}
            className="w-full flex items-center p-5 bg-amber-50 border-2 border-amber-200 rounded-[32px] text-amber-900 hover:bg-amber-100 transition-all shadow-sm hover:shadow-md group"
          >
            <div className="bg-amber-500 p-3 rounded-2xl mr-5 text-white shadow-lg shadow-amber-500/20 group-hover:scale-110 transition-transform">
              <AlertTriangle size={24} />
            </div>
            <div className="text-left">
              <div className="text-base font-black tracking-tight">不動在庫の設定漏れ注意（{inconsistentCodes.length}件）</div>
              <div className="text-xs font-bold opacity-75">
                同一薬品内で「不動在庫」と「通常」の設定が混在しています。クリックして一括修正してください。
              </div>
            </div>
            <div className="ml-auto bg-white/50 p-2 rounded-full group-hover:bg-white transition-colors">
              <ChevronRight size={20} className="text-amber-600" />
            </div>
          </button>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[
            { label: '全在庫', stats: stats.total, color: 'blue', icon: Package },
            { label: '期限切れ', stats: stats.expired, color: 'red', icon: Trash2 },
            { label: '期限切迫 (6ヶ月)', stats: stats.expiringSoon, color: 'orange', icon: Clock },
            { label: '不動在庫', stats: stats.unneeded, color: 'slate', icon: AlertTriangle }
          ].map(card => (
            <div key={card.label} className={`bg-white p-6 rounded-3xl shadow-sm border border-slate-100 border-l-4 border-l-${card.color}-500 hover:shadow-xl hover:-translate-y-1 transition-all duration-300 group`}>
              <div className="flex items-center justify-between mb-4">
                <div className={`bg-${card.color}-50 p-3 rounded-2xl text-${card.color}-600 group-hover:bg-${card.color}-600 group-hover:text-white transition-all`}>
                  <card.icon size={24} />
                </div>
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{card.label}</span>
              </div>
              <div className={`text-2xl font-black text-${card.color === 'blue' || card.color === 'slate' ? 'slate-800' : `${card.color}-600`}`}>
                ¥{card.stats.amount.toLocaleString()}
              </div>
              <div className="text-sm font-bold text-slate-400 mt-1">{card.stats.count.toLocaleString()} <span className="text-[10px] font-medium">品目</span></div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  export default Dashboard;
