import React, { useState, useEffect, useMemo } from 'react';
import { 
  LayoutDashboard, 
  Package, 
  Upload, 
  Settings, 
  X,
  Menu,
  ChevronRight,
  Globe,
  RefreshCw,
  CalendarRange,
  Building2,
  HelpCircle,
  LogOut,
  FileSpreadsheet
} from 'lucide-react';
import { Store, InventoryItem, ViewType } from './types';
import Dashboard from './components/Dashboard';
import InventoryList from './components/InventoryList';
import Import from './components/Import';
import StoreMaster from './components/StoreMaster';
import AdoptionCandidate from './components/AdoptionCandidate';
import FinalDetermination from './components/FinalDetermination';
import RealtimeSearch from './components/RealtimeSearch'; 
import RealtimeStockImport from './components/RealtimeStockImport'; 
import ExpiryImport from './components/ExpiryImport';
import ShipmentStatusImport from './components/ShipmentStatusImport';
import Manual from './components/Manual';
import LoginScreen from './components/LoginScreen';
import UnstockedCompare from './components/UnstockedCompare';

// Supabase client
import { supabase } from './supabase';

const App: React.FC = () => {
  const [session, setSession] = useState<any>(null); // Authセッション用
  const [loading, setLoading] = useState(true); // 起動時ロード用
  const [activeView, setActiveView] = useState<ViewType>('realtime_search');
  const [stores, setStores] = useState<Store[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [currentStoreId, setCurrentStoreId] = useState<string>('');
  const [isStoreInitialSelected, setIsStoreInitialSelected] = useState<boolean>(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(window.innerWidth > 768);
  const [inventoryFilterCodes, setInventoryFilterCodes] = useState<string[] | null>(null);
  const [adoptionViewMode, setAdoptionViewMode] = useState<'search' | 'final'>('search');

  // --- 1. 認証状態の監視と店舗IDの自動取得 ---
  useEffect(() => {
    // 現在のセッションを確認
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      handleStoreAutoSelect(session);
    });

    // ログイン・ログアウト状態の変化を購読
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      handleStoreAutoSelect(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  // ログイン時にMetadataからstore_idをセットする処理
  const handleStoreAutoSelect = (session: any) => {
    if (session?.user) {
      const myStoreId = session.user.user_metadata?.store_id;
      if (myStoreId) {
        setCurrentStoreId(myStoreId);
        localStorage.setItem('last_selected_store_id', myStoreId);
      }
    }
    setLoading(false);
  };

  // --- 2. データ取得（セッションがあるときのみ実行） ---
  useEffect(() => {
    const fetchData = async () => {
      if (!session) return;
      
      try {
        const { data: storesData, error: storesErr } = await supabase.from('stores').select('*');
        if (storesErr) throw storesErr;
        if (storesData) setStores(storesData as Store[]);

        const { data: invData, error: invErr } = await supabase.from('inventory_items').select('*');
        if (invErr) throw invErr;
        if (invData) setInventory(invData.map(mapFromDb));
      } catch (err) {
        console.error('Supabase fetch error', err);
      }
    };
    fetchData();
  }, [session]);

  // 画面幅が変わった時にサイドバーの状態を調整
  useEffect(() => {
    const handleResize = () => {
      setIsSidebarOpen(window.innerWidth > 768);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // ビューが切り替わった時にスマホならサイドバーを閉じる
  const handleNavigate = (view: ViewType) => {
    setActiveView(view);
    if (window.innerWidth <= 768) setIsSidebarOpen(false);
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
    
    unstocked_request_amounts: row.unstocked_request_amounts || {},

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

  // 【重要】以前はinventory配列が変化するたびに全店舗・全品目を丸ごとupsertしていたが、
  // それだと他店が同時に加えた変更を、自分の古いメモリ内容で上書き（ロールバック）してしまう
  // 危険があったため、変更された行だけをピンポイントでUPDATEする方式に変更。
  const updateInventoryItem = async (id: string, patch: Partial<InventoryItem>) => {
    const nowIso = new Date().toISOString();

    // 1. 画面には即座に反映（楽観的更新）
    setInventory(prev => prev.map(item => (
      item.id === id ? { ...item, ...patch, updated_at: nowIso } : item
    )));

    // 2. DBにはこの1行の差分だけを送る
    const { error } = await supabase
      .from('inventory_items')
      .update({ ...patch, updated_at: nowIso })
      .eq('id', id);

    if (error) {
      console.error('inventory update error', error);
      // 失敗時はサーバーの実データを取り直してローカルの状態を正に戻す
      const { data: freshRow } = await supabase
        .from('inventory_items')
        .select('*')
        .eq('id', id)
        .single();
      if (freshRow) {
        const freshItem = mapFromDb(freshRow);
        setInventory(prev => prev.map(item => (item.id === id ? freshItem : item)));
      }
    }
  };

  // 複数行をまとめて更新する場合（一括不要設定など）
  const updateInventoryItems = async (ids: string[], patch: Partial<InventoryItem>) => {
    if (ids.length === 0) return;
    const nowIso = new Date().toISOString();

    setInventory(prev => prev.map(item => (
      ids.includes(item.id) ? { ...item, ...patch, updated_at: nowIso } : item
    )));

    const { error } = await supabase
      .from('inventory_items')
      .update({ ...patch, updated_at: nowIso })
      .in('id', ids);

    if (error) {
      console.error('inventory bulk update error', error);
    }
  };

  const handleJumpToInventoryWithFilter = (codes: string[]) => {
    setInventoryFilterCodes(codes);
    setActiveView('inventory');
  };

const navSections = [
  { title: '', items: [{ id: 'realtime_search', label: '在庫照会', icon: Globe },] },
  { title: '在庫更新', items: [
      { id: 'expiry_import', label: 'STEP1：入庫履歴同期', icon: CalendarRange },
      { id: 'realtime_import', label: 'STEP2：現在庫同期', icon: RefreshCw },
      { id: 'shipment_import', label: '出荷状況インポート', icon: FileSpreadsheet },
    ]},
  { title: '棚卸業務', items: [
      { id: 'dashboard', label: 'ダッシュボード', icon: LayoutDashboard },
      { id: 'inventory', label: '自店在庫仕分け', icon: Package },
      { id: 'adoption', label: '他店在庫の引き受け', icon: Globe },
      { id: 'unstocked_compare', label: '他店有・自店無リスト', icon: Building2 },
      { id: 'import', label: '棚卸データインポート', icon: Upload },
    ]},
  { title: 'マスタ管理', items: [
      { id: 'stores', label: '店舗マスタ', icon: Settings },
    ]},
  { title: 'サポート', items: [
      { id: 'manual', label: '運用マニュアル', icon: HelpCircle }, 
    ]}
];

 // 自店選択を確定させる関数
  const handleInitialStoreSelect = (id: string) => {
    setCurrentStoreId(id);
    setIsStoreInitialSelected(true);
    localStorage.setItem('last_selected_store_id', id);
  };

    // --- 表示制御 ---

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-900 text-white font-black">
        <div className="animate-pulse">PHARMASTOCK JP 起動中...</div>
      </div>
    );
  }

  if (!session) {
    return <LoginScreen />;
  }

  return (
    <div className="h-screen flex bg-slate-100 overflow-hidden font-['Noto_Sans_JP'] text-sm selection:bg-blue-100">
      <PrintStyles /> 
      {isSidebarOpen && window.innerWidth <= 768 && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[45]" onClick={() => setIsSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`no-print bg-slate-900 text-white transition-all duration-300 flex-shrink-0 ${isSidebarOpen ? 'w-64' : 'w-20'} z-50 flex flex-col shadow-2xl overflow-hidden`}>
        <div className="p-4 h-16 flex items-center justify-between border-b border-white/10 flex-shrink-0 bg-slate-950/20">
          {isSidebarOpen && <span className="text-xl font-black tracking-tighter text-blue-400 truncate">PharmaStock JP</span>}
          <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="p-2 hover:bg-white/10 rounded-xl">
            {isSidebarOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
        
        <nav className="flex-1 mt-4 px-3 space-y-6 overflow-y-auto custom-scrollbar">
          {navSections.map((section) => (
            <div key={section.title} className="space-y-1">
              {isSidebarOpen ? <div className="px-3 mb-2 text-[10px] font-black text-slate-500 uppercase tracking-widest">{section.title}</div> : <div className="border-t border-white/5 my-4" />}
              {section.items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => handleNavigate(item.id as ViewType)}
                  className={`w-full flex items-center p-3 rounded-2xl transition-all group ${activeView === item.id ? 'bg-blue-600 text-white shadow-xl' : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'}`}
                >
                  <item.icon size={20} className="flex-shrink-0" />
                  {isSidebarOpen && <span className="ml-4 font-bold">{item.label}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        {/* ログアウトボタンを最下部に追加 */}
        <div className="p-4 bg-slate-950/30 border-t border-white/5">
          <button 
            onClick={() => supabase.auth.signOut()}
            className="w-full flex items-center p-3 rounded-2xl text-slate-400 hover:bg-red-500/10 hover:text-red-400 transition-all"
          >
            <LogOut size={20} />
            {isSidebarOpen && <span className="ml-4 font-bold">ログアウト</span>}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 relative h-screen overflow-hidden">
        <header className="no-print h-16 bg-white/90 backdrop-blur-md border-b flex items-center justify-between px-8 flex-shrink-0 z-40">
          <div className="flex items-center space-x-3">
            <button onClick={() => setIsSidebarOpen(true)} className="md:hidden p-2 text-slate-600">
              <Menu size={20} />
            </button>
            <h2 className="hidden xs:block text-sm font-black text-slate-800">
             {navSections.flatMap(s => s.items).find(i => i.id === activeView)?.label}
            </h2>
            <span className="hidden xs:block text-slate-200">/</span>
            {/* 店舗切り替え機能は維持 */}
            <div className="relative group">
              <select
                value={currentStoreId}
                onChange={(e) => setCurrentStoreId(e.target.value)}
                className="appearance-none bg-blue-50 text-blue-700 text-xs font-black py-1.5 pl-3 pr-8 rounded-full border border-blue-100 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 max-w-[200px] truncate"
              >
                {stores.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-blue-600">
                <ChevronRight size={14} className="rotate-90" />
              </div>
            </div>
          </div>
          <div className="hidden sm:block text-[10px] font-black text-slate-400 uppercase tracking-widest">PharmaStock JP</div>
        </header>

        <div className={`flex-1 flex flex-col min-h-0 ${activeView === 'inventory' ? 'overflow-hidden' : 'overflow-y-auto custom-scrollbar'}`}>
          <div className="flex-1 flex flex-col min-h-0 p-4 md:p-8">
            {activeView === 'dashboard' && <Dashboard inventory={inventory} currentStoreId={currentStoreId} stores={stores} onNavigate={handleNavigate} onJumpToFilter={handleJumpToInventoryWithFilter} />}
            {activeView === 'realtime_search' && <RealtimeSearch stores={stores} currentStoreId={currentStoreId} />}
            {activeView === 'unstocked_compare' && <UnstockedCompare inventory={inventory} stores={stores} currentStoreId={currentStoreId} />}
            {activeView === 'expiry_import' && <ExpiryImport storeId={currentStoreId} stores={stores} />}
            {activeView === 'inventory' && <InventoryList inventory={inventory} onUpdateItem={updateInventoryItem} onUpdateItems={updateInventoryItems} currentStoreId={currentStoreId} stores={stores} filterCodes={inventoryFilterCodes} onClearFilter={() => setInventoryFilterCodes(null)} />}
            {activeView === 'realtime_import' && <RealtimeStockImport storeId={currentStoreId} stores={stores} />}
            {activeView === 'shipment_import' && <ShipmentStatusImport storeId={currentStoreId} stores={stores} />}
            {activeView === 'adoption' && (
              <div className="flex flex-col h-full space-y-4">
                <div className="flex bg-white p-1 rounded-2xl shadow-sm border border-slate-200 w-full sm:w-fit self-center">
                  <button onClick={() => setAdoptionViewMode('search')} className={`flex-1 sm:flex-none px-6 py-2 rounded-xl font-black text-xs transition-all ${adoptionViewMode === 'search' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-400'}`}>引受検討</button>
                  <button onClick={() => setAdoptionViewMode('final')} className={`flex-1 sm:flex-none px-6 py-2 rounded-xl font-black text-xs transition-all ${adoptionViewMode === 'final' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-400'}`}>確定リスト</button>
                </div>

    {/* コンテンツエリア */}
    <div className="flex-1 min-h-0">
      {adoptionViewMode === 'search' ? (
        <AdoptionCandidate 
          inventory={inventory} 
          onUpdateItem={updateInventoryItem}
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