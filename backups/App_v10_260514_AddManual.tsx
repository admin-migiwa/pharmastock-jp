import React, { useState, useEffect, useMemo } from 'react';
import { 
  LayoutDashboard, 
  Package, 
  ArrowLeftRight, 
  Upload, 
  Settings, 
  X,
  Menu,
  ChevronRight,
  Globe,
  RefreshCw,
  CalendarRange,
  Building2,
  HelpCircle
} from 'lucide-react';
import { Store, InventoryItem, ViewType } from './types';
import Dashboard from './components/Dashboard';
import InventoryList from './components/InventoryList';
import Matching from './components/Matching';
import Import from './components/Import';
import StoreMaster from './components/StoreMaster';
import AdoptionCandidate from './components/AdoptionCandidate';
import FinalDetermination from './components/FinalDetermination';
import RealtimeSearch from './components/RealtimeSearch'; 
import RealtimeStockImport from './components/RealtimeStockImport'; 
import ExpiryImport from './components/ExpiryImport';
import Manual from './components/Manual';

// Supabase client
import { supabase } from './supabase';

const App: React.FC = () => {
  const [activeView, setActiveView] = useState<ViewType>('realtime_search');
  const [stores, setStores] = useState<Store[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [currentStoreId, setCurrentStoreId] = useState<string>('');
  const [isStoreInitialSelected, setIsStoreInitialSelected] = useState<boolean>(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(window.innerWidth > 768);
  const [inventoryFilterCodes, setInventoryFilterCodes] = useState<string[] | null>(null);
  const [adoptionViewMode, setAdoptionViewMode] = useState<'search' | 'final'>('search');

    // 画面幅が変わった時にサイドバーの状態を調整
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth <= 768) {
        setIsSidebarOpen(false);
      } else {
        setIsSidebarOpen(true);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // ビューが切り替わった時にスマホならサイドバーを閉じる
  const handleNavigate = (view: ViewType) => {
    setActiveView(view);
    if (window.innerWidth <= 768) {
      setIsSidebarOpen(false);
    }
  };

  // helpers to convert between our client type and the Supabase table schema
  const mapFromDb = (row: any): InventoryItem => ({
    id: row.id,
    store_id: row.store_id,
    // required 22 columns
    name: row.name || '',
    spec: row.spec || '',
    unit: row.unit || '',
    price: Number(row.price) || 0,
    lot_number: row.lot_number || '',
    expiry_date: row.expiry_date || '',
    stock_total: Number(row.stock_total) || 0,
    total_amount: (row.total_amount || row.inventory_amount || 0),
    // JSONB型として取得されるため、空なら空オブジェクトをセット
    requested_amounts: row.requested_amounts || {},
    is_dead_stock: row.is_dead_stock ?? false,
    dead_stock_flag_date: row.dead_stock_flag_date ?? null,
    is_locked: row.is_locked ?? false,
    updated_at: row.updated_at,
    adopting_store_ids: row.adopting_store_ids || [],
    // optional / legacy columns
    gs1_code: row.gs1_code || '',
    jan_code: row.jan_code || '',
    yakka_code: row.yakka_code || row.yj_code || '',
    individual_code: row.individual_code || '',
    receipt_code: row.receipt_code || '',
    manufacturer: row.manufacturer || '',
    distributor: row.distributor || '',
    package_type: row.package_type || '',
    unit_type: row.unit_type || '',
    calc_unit_price: Number(row.calc_unit_price) || 0,
    category: row.category || '',
    trade_type: row.trade_type || '',
    created_at: row.created_at,
  });

  const mapToDb = (item: InventoryItem) => ({
    id: item.id,
    store_id: item.store_id,
    name: item.name,
    spec: item.spec,
    unit: item.unit,
    price: item.price,
    lot_number: item.lot_number,
    expiry_date: item.expiry_date,
    stock_total: item.stock_total,
    total_amount: item.total_amount,
    // 保存時もそのままJSONBとして送る
    requested_amounts: item.requested_amounts || {},
    is_dead_stock: item.is_dead_stock,
    dead_stock_flag_date: item.dead_stock_flag_date,
    is_locked: item.is_locked,
    updated_at: new Date().toISOString(),
    adopting_store_ids: item.adopting_store_ids || [],
    gs1_code: item.gs1_code,
    jan_code: item.jan_code,
    yakka_code: item.yakka_code,
    individual_code: item.individual_code,
    receipt_code: item.receipt_code,
    manufacturer: item.manufacturer,
    distributor: item.distributor,
    package_type: item.package_type,
    unit_type: item.unit_type,
    calc_unit_price: item.calc_unit_price,
    category: item.category,
    trade_type: item.trade_type,
    created_at: item.created_at,
  });

  // Initialize Data (load from Supabase if available)
  useEffect(() => {
    const fetchData = async () => {
      try {
        const { data: storesData, error: storesErr } = await supabase.from('stores').select('*');
        if (storesErr) throw storesErr;
        
        if (storesData && storesData.length > 0) {
           const activeStores = storesData as Store[];
          setStores(activeStores);
          // localStorageに以前の選択があれば復元、なければ未選択状態
          const savedStoreId = localStorage.getItem('last_selected_store_id');
          if (savedStoreId && activeStores.find(s => s.id === savedStoreId)) {
            setCurrentStoreId(savedStoreId);
            setIsStoreInitialSelected(true); // 過去に選択済みならスキップ可
          }
        }
        // 2. 在庫データを取得
        const { data: invData, error: invErr } = await supabase.from('inventory_items').select('*');
        if (invErr) throw invErr;
        if (invData) setInventory(invData.map(mapFromDb));
      } catch (err) {
        console.error('Supabase fetch error', err);
      }
    };
    fetchData();
  }, []);

  // Persistence
    useEffect(() => {
    if (activeView !== 'inventory') {
      setInventoryFilterCodes(null);
    }
  }, [activeView]);

  useEffect(() => {
    if (stores.length > 0) {
      localStorage.setItem('pharma_stores', JSON.stringify(stores));
      // sync to Supabase
      supabase.from('stores').upsert(stores).then(({ error }) => {
        if (error) console.error('store upsert error', error);
      });
    }
  }, [stores]);

  useEffect(() => {
    localStorage.setItem('pharma_inventory', JSON.stringify(inventory));
    // sync to Supabase
    if (inventory.length > 0) {
      const dbRows = inventory.map(mapToDb);
      supabase.from('inventory_items').upsert(dbRows).then(({ error }) => {
        if (error) console.error('inventory upsert error', error);
      });
    }
  }, [inventory]);

  const handleJumpToInventoryWithFilter = (codes: string[]) => {
    setInventoryFilterCodes(codes);
    setActiveView('inventory');
  };

  const currentStore = useMemo(() => 
    stores.find(s => s.id === currentStoreId), 
    [stores, currentStoreId]
  );

const navSections = [
  {
    title: '', // タイトルなし（上部セクション）
    items: [
      { id: 'realtime_search', label: '在庫照会', icon: Globe },
    ]
  },
  {
    title: '在庫更新', // 在庫更新というタイトルでグルーピング
    items: [
      { 
        id: 'expiry_import', 
        label: 'STEP1：入庫履歴同期', 
        icon: CalendarRange 
      },
      { 
        id: 'realtime_import', 
        label: 'STEP2：現在庫同期', 
        icon: RefreshCw 
      },
    ]
  },
  {
    title: '棚卸業務',
    items: [
      { id: 'dashboard', label: 'ダッシュボード', icon: LayoutDashboard },
      { id: 'inventory', label: '自店在庫仕分け', icon: Package },
      { id: 'adoption', label: '他店在庫の引き受け', icon: Globe },
      { id: 'matching', label: '在庫マッチング', icon: ArrowLeftRight },
      { id: 'import', label: '棚卸データインポート', icon: Upload },
    ]
  },
  {
    title: 'マスタ管理',
    items: [
      { id: 'stores', label: '店舗マスタ', icon: Settings },
    ]
  },
    {
    title: 'サポート',
    items: [
      { id: 'manual', label: '運用マニュアル', icon: HelpCircle }, 
    ]
  }
];

 // 自店選択を確定させる関数
  const handleInitialStoreSelect = (id: string) => {
    setCurrentStoreId(id);
    setIsStoreInitialSelected(true);
    localStorage.setItem('last_selected_store_id', id);
  };

  // --- 1. 自店選択画面 (オーバーレイ) ---
  if (!isStoreInitialSelected && stores.length > 0) {
    return (
      <div className="fixed inset-0 z-[9999] bg-slate-900/90 backdrop-blur-md flex items-center justify-center p-4">
        <div className="bg-white w-full max-w-md rounded-[32px] shadow-2xl p-8 animate-in zoom-in duration-300">
          <div className="text-center space-y-2 mb-8">
            <div className="w-16 h-16 bg-blue-100 text-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Building2 size={32} />
            </div>
            <h1 className="text-2xl font-black text-slate-900 tracking-tight">自店を選択してください</h1>
            <p className="text-slate-500 font-bold text-sm">本日の業務を行うメイン店舗を選択します</p>
          </div>

          <div className="space-y-3">
            {stores.map((store) => (
              <button
                key={store.id}
                onClick={() => handleInitialStoreSelect(store.id)}
                className="w-full group flex items-center justify-between p-4 rounded-2xl border-2 border-slate-100 hover:border-blue-500 hover:bg-blue-50 transition-all duration-200"
              >
                <div className="flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full bg-slate-300 group-hover:bg-blue-500 transition-colors" />
                  <span className="font-black text-slate-700 group-hover:text-blue-700 transition-colors">
                    {store.name}
                  </span>
                </div>
                <ChevronRight className="text-slate-300 group-hover:text-blue-500 group-hover:translate-x-1 transition-all" size={18} />
              </button>
            ))}
          </div>

          <p className="mt-8 text-center text-[10px] font-black text-slate-400 uppercase tracking-widest">
            PharmaStock JP - Professional
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-slate-100 overflow-hidden font-['Noto_Sans_JP'] text-sm selection:bg-blue-100">
      <PrintStyles /> 
      {/* スマホ用オーバーレイ (サイドバーが開いている時のみ表示) */}
      {isSidebarOpen && window.innerWidth <= 768 && (
        <div 
          className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[45] animate-in fade-in duration-300"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`no-print bg-slate-900 text-white transition-all duration-300 flex-shrink-0 ${isSidebarOpen ? 'w-64' : 'w-20'} z-50 flex flex-col shadow-2xl overflow-hidden`}>
        <div className="p-4 h-16 flex items-center justify-between border-b border-white/10 flex-shrink-0 bg-slate-950/20">
          {isSidebarOpen && <span className="text-xl font-black tracking-tighter text-blue-400 truncate">PharmaStock JP</span>}
          <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="p-2 hover:bg-white/10 rounded-xl transition-colors">
            {isSidebarOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
        
        <nav className="flex-1 mt-4 px-3 space-y-6 overflow-y-auto custom-scrollbar">
          {navSections.map((section) => (
            <div key={section.title} className="space-y-1">
              {/* セクションタイトル */}
              {isSidebarOpen ? (
                <div className="px-3 mb-2 text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">
                  {section.title}
                </div>
              ) : (
                <div className="border-t border-white/5 my-4" />
              )}

              {section.items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => handleNavigate(item.id as ViewType)}
                  className={`w-full flex items-center p-3 rounded-2xl transition-all duration-200 group ${
                    activeView === item.id 
                      ? 'bg-blue-600 text-white shadow-xl shadow-blue-600/20 translate-x-1' 
                      : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
                  }`}
                >
                  <item.icon size={20} className="flex-shrink-0" />
                  {isSidebarOpen && <span className="ml-4 font-bold whitespace-nowrap">{item.label}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="p-4 bg-slate-950/30 flex-shrink-0 border-t border-white/5 text-center">
          {isSidebarOpen ? (
            <div className="text-[10px] font-bold text-slate-600 tracking-widest">
              v1.2.0-PRO
            </div>
          ) : (
            <div className="flex justify-center text-slate-700">
              <Settings size={16} />
            </div>
          )}
        </div>
      </aside>

      {/* Main Container */}
      <main className="flex-1 flex flex-col min-w-0 relative h-screen overflow-hidden">
        {/* Header - Fixed */}
        <header className="no-print h-16 bg-white/90 backdrop-blur-md border-b flex items-center justify-between px-8 flex-shrink-0 z-40">
          <div className="flex items-center space-x-2 md:space-x-3 min-w-0">
            {/* スマホ用メニュー開閉ボタン (モバイル時のみ表示) */}
            <button 
              onClick={() => setIsSidebarOpen(true)}
              className="md:hidden p-2 text-slate-600 hover:bg-slate-100 rounded-lg"
            >
              <Menu size={20} />
            </button>

            <h2 className="hidden xs:block text-xs md:text-sm font-black text-slate-800 truncate max-w-[80px] md:max-w-none">
             {navSections.flatMap(s => s.items).find(i => i.id === activeView)?.label}
            </h2>
            <span className="hidden xs:block text-slate-200">/</span>
            <div className="relative group">
              <select
                value={currentStoreId}
                onChange={(e) => setCurrentStoreId(e.target.value)}
                className="appearance-none bg-blue-50 hover:bg-blue-100 text-blue-700 text-[11px] md:text-xs font-black py-1.5 pl-3 pr-8 rounded-full border border-blue-100 cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 max-w-[150px] md:max-w-[200px] truncate"
              >
                {stores.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              {/* セレクトボックスの矢印アイコンをカスタムで配置 */}
              <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-blue-600">
                <ChevronRight size={14} className="rotate-90" />
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <div className="hidden sm:block text-[10px] font-black text-slate-400 bg-slate-50 px-3 py-1.5 rounded-lg border uppercase tracking-widest">
              PharmaStock JP
            </div>
          </div>
        </header>

        {/* Scrollable Content */}
         <div className={`flex-1 flex flex-col min-h-0 ${activeView === 'inventory' ? 'overflow-hidden' : 'overflow-y-auto custom-scrollbar'}`}>
           <div className="flex-1 flex flex-col min-h-0 p-4 md:p-8">
            {activeView === 'dashboard' && <Dashboard inventory={inventory} currentStoreId={currentStoreId} stores={stores} onNavigate={handleNavigate} onJumpToFilter={handleJumpToInventoryWithFilter} />}
            {activeView === 'realtime_search' && (<RealtimeSearch stores={stores} currentStoreId={currentStoreId} />)}
            {activeView === 'expiry_import' && (<ExpiryImport storeId={currentStoreId} stores={stores} />)}
            {activeView === 'inventory' && <InventoryList inventory={inventory} setInventory={setInventory} currentStoreId={currentStoreId} stores={stores} filterCodes={inventoryFilterCodes}  onClearFilter={() => setInventoryFilterCodes(null)} />}
            {activeView === 'realtime_import' && (<RealtimeStockImport storeId={currentStoreId} stores={stores} />)}
            {activeView === 'adoption' && (  
              <div className="flex flex-col h-full space-y-4">
                <div className="flex bg-white p-1 rounded-2xl shadow-sm border border-slate-200 w-full sm:w-fit self-center no-print">
                  <button
                    onClick={() => setAdoptionViewMode('search')}
                    className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 md:px-6 py-2 rounded-xl font-black text-[10px] md:text-xs transition-all ${
                      adoptionViewMode === 'search' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-400'
                    }`}
                  >
                    <Globe size={14} />
                    <span>引受検討</span>
                  </button>
                  <button
                    onClick={() => setAdoptionViewMode('final')}
                    className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 md:px-6 py-2 rounded-xl font-black text-[10px] md:text-xs transition-all ${
                      adoptionViewMode === 'final' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-400'
                    }`}
                  >
                    <ArrowLeftRight size={14} />
                    <span>確定リスト</span>
                  </button>
                </div>

    {/* コンテンツエリア */}
    <div className="flex-1 min-h-0">
      {adoptionViewMode === 'search' ? (
        <AdoptionCandidate 
          inventory={inventory} 
          setInventory={setInventory} 
          currentStoreId={currentStoreId} 
          stores={stores} 
        />
      ) : (
        <FinalDetermination 
          inventory={inventory} 
          currentStoreId={currentStoreId} 
          stores={stores} 
        />
      )}
    </div>
  </div>
)} 
            {activeView === 'matching' && <Matching inventory={inventory} stores={stores} currentStoreId={currentStoreId} />}
            {/* Added missing 'stores' prop below */}
            {activeView === 'import' && <Import inventory={inventory} setInventory={setInventory} currentStoreId={currentStoreId} stores={stores} />}
            {activeView === 'stores' && <StoreMaster stores={stores} setStores={setStores} inventory={inventory} setInventory={setInventory} currentStoreId={currentStoreId} setCurrentStoreId={setCurrentStoreId} />}
            {activeView === 'manual' && <Manual />}
          </div>
        </div>
      </main>
    </div>
  );
};
// 印刷用のスタイルを強制的に注入するコンポーネント
const PrintStyles = () => (
  <style dangerouslySetInnerHTML={{ __html: `
    @media print {
      /* 1. 不要なUIを完全に非表示にする */
      .no-print, 
      aside, 
      header, 
      nav, 
      button,
      select {
        display: none !important;
      }

      /* 2. メインコンテンツの余白をリセットして全幅表示 */
      main {
        margin: 0 !important;
        padding: 0 !important;
        width: 100% !important;
        position: absolute !important;
        left: 0 !important;
        top: 0 !important;
        background-color: white !important;
      }

      /* 3. 背景色やバッジの色を印刷でも有効にする */
      body {
        background-color: white !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }

      /* 4. スクロール領域を解除して全部出す */
      .overflow-y-auto {
        overflow: visible !important;
        height: auto !important;
      }

      /* 5. テーブルの改ページ設定 */
      tr {
        page-break-inside: avoid !important;
      }
    }
  `}} />
);

export default App;