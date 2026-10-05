
export interface Store {
  id: string;
  name: string;
}

export interface InventoryItem {
  id: string;
  store_id: string;
  // 22項目スキーマの必須カラム
  name: string; 
  spec: string; 
  unit: string;
  price: number;
  lot_number: string;
  expiry_date: string;
  stock_total: number;
  total_amount: number;  
  

  // フラグ類
  is_dead_stock: boolean;   
  is_locked: boolean;
  dead_stock_flag_date?: string | null; 
  // 不動在庫のうち「不要な数量」（在庫数の一部だけを不要とする場合に使用。未設定time=旧データはstock_totalとして扱う）
  dead_stock_qty?: number;

  // どの店舗が「何個」欲しいと言っているかを保持
  // 例: { "store_uuid_A": 100, "store_uuid_B": 50 }
  requested_amounts?: Record<string, number>; 

  unstocked_request_amounts?: Record<string, number>;

   // --- 引受管理用 ---
  // この薬品に対して「引き受けたい」と手を挙げている店舗IDのリスト
  // 複数店舗が候補に上がる可能性があるため、配列で管理します
  adopting_store_ids?: string[]; 
  
  // 最終的にどの店舗に送るか確定した際の宛先店舗ID
  final_destination_id?: string | null;

  // 拡張／オプションカラム（必要に応じて埋まる、DBでは DEFAULT '' や NULL）
  gs1_code?: string;
  jan_code?: string;
  yakka_code?: string; 
  individual_code?: string;
  receipt_code?: string;
  manufacturer?: string;
  distributor?: string;
  package_type?: string;
  unit_type?: string;
  calc_unit_price?: number;
  category?: string;
  trade_type?: string;

  // システムタイムスタンプ
  created_at?: string;
  updated_at: string;
}

export interface MatchingResult {
  sourceItem: InventoryItem;
  matches: {
    store: Store;
    inventory: InventoryItem;
    rank: number;
    expiryAlert: boolean;
    matchLevel: 1 | 2 | 3; // 段階的マッチング: 1=完全一致, 2=上9桁, 3=上7桁
  }[];
}

/**
 * レセコンから抽出した「現在の在庫」データ
 * 棚卸データ(InventoryItem)とは異なり、ロットや期限が含まれない簡易的な構成
 */
export interface RealtimeStock {
  id: string;          // UUID
  store_id: string;    // 店舗ID
  yakka_code: string;  // 薬価基準コード
  name: string;        // 薬品名
  spec: string;        // 規格
  stock_qty: number;   // 現在庫数
  unit: string;        // 単位
  expiry_date: string | null; // 期限（わかる範囲で、なければnull）
  updated_at: string;  // インポート全体の更新日時
  stock_updated_at?: string;      // 在庫数自体の更新日時（レセコン由来）
  last_purchase_updated_at: string | null; // 入庫履歴テーブルの最終更新日時（Viewで結合）
}


// 他店舗のリアルタイム在庫を検索した際の結果用
export interface RealtimeSearchResult {
  store: Store;
  stock: RealtimeStock;
}

// --- 追加：入庫履歴（期限推測用）の型定義 ---
export interface PurchaseHistory {
  id: string;
  store_id: string;
  purchase_date: string;
  yakka_code: string;
  name: string;
  lot_number: string;
  expiry_date: string;
  quantity: number;
  updated_at: string;
}

// --- 出荷調整状況（厚労省「医療用医薬品の供給状況」）---
export interface ShipmentStatus {
  yj_code: string;               // ⑤YJコード
  name: string;                  // ⑥品名
  name_key?: string;             // 照合用に正規化した品名
  maker?: string | null;         // ⑦製造販売業者名
  status: string;                // ⑫出荷対応の状況（例：①通常出荷）
  status_date?: string | null;   // ⑬⑫の更新日
  reason?: string | null;        // ⑭限定出荷/供給停止の理由
  outlook?: string | null;       // ⑮解除/解消見込み
  outlook_detail?: string | null;// ⑯解除/解消見込み時期（在庫消尽時期）
  volume_status?: string | null; // ⑰出荷量の現在の状況
  volume_outlook?: string | null;// ⑱出荷量の改善見込み時期
  volume_amount?: string | null; // ⑲出荷量の改善見込み量
  info_date?: string | null;     // ⑳⑫以外の更新日
  is_new?: boolean;              // 今回掲載時の更新有無（New）
  is_adjusting: boolean;         // 出荷調整中（通常出荷以外／出荷量減少・停止等）
  imported_at?: string;
}

// 在庫1行に対する出荷状況の突合結果
//  code: YJコード一致 / name: 名称一致 / dict: 他店辞書で補完 / ambiguous: 複数候補（要確認） / none: 情報なし
export interface ShipmentLookup {
  kind: 'code' | 'name' | 'dict' | 'ambiguous' | 'none';
  rows: ShipmentStatus[];
}

export type ViewType = 'dashboard' | 'realtime_search' | 'inventory' | 'adoption' | 'realtime_import' | 'expiry_import' | 'shipment_import' | 'import' | 'stores' | 'manual' | 'unstocked_compare';
