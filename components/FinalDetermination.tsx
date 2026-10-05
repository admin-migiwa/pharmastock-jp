import React, { useMemo, useState } from 'react';
import { ArrowUpRight, ArrowDownLeft, Trash2, Printer, Calculator, Repeat } from 'lucide-react';
import { InventoryItem, Store } from '../types';

interface FinalDeterminationProps {
  inventory: InventoryItem[];
  currentStoreId: string;
  stores: Store[];
}

const FinalDetermination: React.FC<FinalDeterminationProps> = ({
  inventory,
  currentStoreId,
  stores
}) => {
  const [activeTab, setActiveTab] = useState<'shipping' | 'receiving' | 'dead' | 'exchange'>('shipping');
    // 全店モードかどうかの判定
  const isAllStores = currentStoreId === 'all';

  // --- ロジック層：回転率に基づく第一候補判定 ---
  const getSortedAdopters = (item: InventoryItem) => {
    const adopters = item.adopting_store_ids || [];
    return adopters.map(storeId => {
      const targetInvList = inventory.filter(i => 
        i.store_id === storeId && 
        i.yakka_code?.substring(0, 9) === item.yakka_code?.substring(0, 9)
      );
      // 手動入力された希望数量を取得
      const requestedAmount = item.requested_amounts?.[storeId] || 0;
      // 在庫データがなく、かつ希望数量も0なら対象外
      if (targetInvList.length === 0 && requestedAmount === 0) return null;
      // スコアリングロジック
      // 4: 完全一致（現役）
      // 3: 銘柄違い（現役）
      // 2: 採用はあるが、引受先でも不要フラグが立っている
      // 1: その他
      let score = 1;
      const exactMatch = targetInvList.find(i => i.yakka_code === item.yakka_code);
      const isAnyDead = targetInvList.some(i => i.is_dead_stock);

      if (isAnyDead) {
        score = 2; // 自店でも余っている場合は優先度低
      } else if (exactMatch) {
        score = 4; // 完全一致
      } else if (targetInvList.length > 0) {
        score = 3; // 銘柄違い・先発後発違い
      }

      // 代表的な在庫情報を取得
      const representative = exactMatch || targetInvList[0];
      return {
        storeId,
        score, // ソート用にスコアを保持
        isDead: isAnyDead ? 1 : 0,
        expiry: representative?.expiry_date || '0000-00-00',
        stock: representative?.stock_total || 0,
        requestedAmount: requestedAmount
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null && c.requestedAmount > 0)
    .sort((a, b) => {
      // 1. スコアが高い（4:完全一致）順
      if (b.score !== a.score) return b.score - a.score;
      // 2. 自店で余っていない（isDeadが0）方を優先
      if (a.isDead !== b.isDead) return a.isDead - b.isDead;
      // 3. 期限が遠い（新しい）順に引き受けてもらう
      if (a.expiry !== b.expiry) return b.expiry.localeCompare(a.expiry);
      // 4. それでも同じなら、在庫数が多い店を優先
      return b.stock - a.stock;
    });
  };

  // --- データ層：全店対応版の抽出 ---
  const reportData = useMemo(() => {
    // 【共通ソート関数】期限(昇順) > 薬品名(昇順)
    const sortByExpiryAndName = (a: any, b: any) => {
      const dateA = a.expiry_date || '9999-12-31';
      const dateB = b.expiry_date || '9999-12-31';
      if (dateA !== dateB) return dateA.localeCompare(dateB);
      return a.name.localeCompare(b.name, 'ja');
    };

    // 【一括表示用ソート関数】店舗名(昇順) > 期限(昇順) > 薬品名(昇順)
    const sortByStoreExpiryName = (a: any, b: any) => {
      const storeA = stores.find(s => s.id === a.store_id)?.name || '';
      const storeB = stores.find(s => s.id === b.store_id)?.name || '';
      if (storeA !== storeB) return storeA.localeCompare(storeB, 'ja');
      return sortByExpiryAndName(a, b);
    };

    // 全アイテムに対して配分（assignments）を計算
    const allItemsWithAssignments = inventory.map(item => {
      // 不要フラグ（is_dead_stock）が立っていない場合は、配分を計算しない
      if (!item.is_dead_stock) {
        return { ...item, assignments: [], realDeadQty: 0 };
      }
      const sortedAdopters = getSortedAdopters(item);
      // 「不要数量」が指定されていればそれを、未設定（マイグレーション前の古いデータ等）なら
      // 従来通り在庫数全部を対象にする
      let remainingStock = item.dead_stock_qty ?? item.stock_total;
      const assignments: { storeId: string; qty: number }[] = [];

      // 優先順位が高い順に在庫を割り当て
      // 【方針転換】期限切れリスクを避けるため、is_locked（キープ・交換希望）品も
      // 通常の不要在庫と同様に扱い、実際に在庫を減算する（出庫・引受を確実に実施する）
      sortedAdopters.forEach(adopter => {
        if (remainingStock <= 0) return;
        const allocated = Math.min(remainingStock, adopter.requestedAmount);
        if (allocated > 0) {
          assignments.push({ storeId: adopter.storeId, qty: allocated });
          remainingStock -= allocated;
        }
      });

      const realDeadQty = remainingStock;

      return { ...item, assignments, realDeadQty };
    });

    // フィルタリング条件の定義
    // 「出庫」= 手放してよい不動在庫（is_locked＝キープ品も含める。期限切れ回避を優先するため）
    const shipping = allItemsWithAssignments
      .filter(i =>  i.is_dead_stock && (isAllStores ? true : i.store_id === currentStoreId)  && i.assignments.length > 0)
      .sort(sortByStoreExpiryName);
    const receiving = allItemsWithAssignments
      .filter(i => 
        i.is_dead_stock && 
        (isAllStores ? i.assignments.length > 0 : i.assignments.some(a => a.storeId === currentStoreId))
      )
      .sort(sortByStoreExpiryName);
    // 「不動」= 引受先が見つからず処理が必要な在庫（is_locked＝キープ品も含める）
    const dead = allItemsWithAssignments
      .filter(i => (isAllStores ? true : i.store_id === currentStoreId) && i.realDeadQty > 0 && i.is_dead_stock)
      .sort(sortByStoreExpiryName);
    // 「交換希望」= キープ品だったことがわかる目印用の一覧（出庫・不動の集計にも二重で含まれる）
    const exchange = allItemsWithAssignments
      .filter(i => i.is_dead_stock && i.is_locked && (isAllStores ? true : i.store_id === currentStoreId))
      .sort(sortByStoreExpiryName);

    const getPrice = (item: InventoryItem, qty: number) => {
      if (item.stock_total && item.stock_total > 0) {
        return (item.total_amount * qty) / item.stock_total;
      }
      return 0;
    };    

    return {
      shipping,
      receiving,
      dead,
      exchange,
      totals: {
        shipping: shipping.reduce((sum, i) => sum + i.assignments.reduce((s, a) => s + getPrice(i, a.qty), 0), 0),
        receiving: receiving.reduce((sum, i) => {
          const targetQty = isAllStores ? i.assignments.reduce((s, a) => s + a.qty, 0) : (i.assignments.find(a => a.storeId === currentStoreId)?.qty || 0);
          return sum + getPrice(i, targetQty);
        }, 0),
        dead: dead.reduce((sum, i) => sum + getPrice(i, i.realDeadQty), 0),
        // 交換希望は出庫/不動と二重計上する目印のため、実際に動く数量（出庫分＋不動分）で計算する
        exchange: exchange.reduce((sum, i) => {
          const shippedQty = i.assignments.reduce((s, a) => s + a.qty, 0);
          return sum + getPrice(i, shippedQty + i.realDeadQty);
        }, 0)
      },
      allStoresSummary: stores.map(store => ({
        storeName: store.name,
        shippingItems: allItemsWithAssignments.filter(i => i.store_id === store.id && i.assignments.length > 0).sort(sortByStoreExpiryName),
        deadItems: allItemsWithAssignments.filter(i => i.store_id === store.id && i.realDeadQty > 0 && i.is_dead_stock).sort(sortByStoreExpiryName),
        exchangeItems: allItemsWithAssignments.filter(i => i.store_id === store.id && i.is_locked && i.is_dead_stock).sort(sortByStoreExpiryName)
      })).filter(s => s.shippingItems.length > 0 || s.deadItems.length > 0 || s.exchangeItems.length > 0)
    };
  }, [inventory, currentStoreId, isAllStores, stores]);

  // --- 印刷用：HTML生成ロジック ---
  const handlePrintAction = (mode: 'single' | 'all') => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

        // 期限が2行にならないよう、white-space: nowrapを追加し、列幅を調整
    const commonStyles = `
      @media print { 
        @page { size: A4; margin: 10mm; }
        .page-break { break-after: page; } 
        /* 背景色・文字色がプリンター印刷時に消えるのを防ぐ（PDF保存では発生せず、
           実プリンターへの印刷でのみ再現するブラウザのデフォルト挙動への対処） */
        * {
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
          color-adjust: exact !important;
        }
        table { width: 100%; border-collapse: collapse; margin-bottom: 15px; table-layout: fixed; } 
        th, td { 
          border: 1px solid #cbd5e1; 
          padding: 4px 6px; 
          font-size: 10px; /* 全体的に文字を小さく */
          line-height: 1.2;
          word-wrap: break-word; 
        } 
        th { background-color: #f8fafc; font-weight: bold; }
        
        /* 列幅の明示的な割り振り */
        .col-partner { width: 75px; }      /* 店舗名 */
        .col-name { width: auto; }         /* 薬品名 / 規格 */
        .col-qty { width: 60px; text-align: right; white-space: nowrap; }    /* 数量 */
        .col-expiry { width: 70px; white-space: nowrap; text-align: center; } /* 期限 */
        .col-lot { width: 80px; text-align: center; }                         /* ロット番号 */
        
        b { font-size: 10.5px; } /* 薬品名だけ少し強調 */
        small { font-size: 9px; color: #64748b; } /* 規格はさらに小さく */
      }
    `;

    let content = `<html><head><title>指示書</title>
    <script src="https://cdn.tailwindcss.com"></script><style>${commonStyles}</style></head><body class="p-4">`;

    if (mode === 'all') {
      content += `<h1 class="text-xl font-black mb-6 border-b-2 border-slate-900 pb-1">全店舗 譲渡・不動在庫一括報告書</h1>`;
      // ★：全店舗の不動在庫を一括で集計・ソート
      const allDeadStockItems = reportData.allStoresSummary.flatMap(summary => 
        summary.deadItems.map(item => ({
          storeName: summary.storeName,
          name: item.name,
          spec: item.spec,
          manufacturer: item.manufacturer || '-', 
          distributor: item.distributor || '-',
          lot: item.lot_number || '-',
          expiry: item.expiry_date,
          qty: item.realDeadQty,
          unit: item.unit
        }))
      ).sort((a, b) => {
        if (a.storeName !== b.storeName) return a.storeName.localeCompare(b.storeName, 'ja');
        if (a.expiry !== b.expiry) return (a.expiry || '').localeCompare(b.expiry || '');
        return a.name.localeCompare(b.name, 'ja');
      });
      reportData.allStoresSummary.forEach(summary => {
        if (summary.shippingItems.length > 0) {
          content += `<div class="mb-8">
            <h2 class="text-md font-bold bg-slate-100 p-1 mb-3">【店舗名：${summary.storeName}】</h2>`;
          // --- 出庫データのフラット化と再ソート ---
          const flatShipping = summary.shippingItems.flatMap(i => 
            i.assignments.map(a => ({
              partner: stores.find(s => s.id === a.storeId)?.name || '不明',
              name: i.name,
              spec: i.spec,
              expiry: i.expiry_date,
              qty: a.qty,
              unit: i.unit,
              isExchange: i.is_locked
            }))
          ).sort((a, b) => {
            if (a.partner !== b.partner) return a.partner.localeCompare(b.partner, 'ja');
            if (a.expiry !== b.expiry) return a.expiry.localeCompare(b.expiry);
            return a.name.localeCompare(b.name, 'ja');
          });
          content += `<h3 class="text-[10px] font-bold text-blue-700 mb-1">▼ 他店への出庫</h3>
            <table><thead><tr><th class="col-partner">分譲先</th><th class="col-name">薬品名 / 規格</th><th
             class="col-expiry">期限</th><th class="col-qty">数量</th></tr></thead><tbody>`;
          flatShipping.forEach(row => {
            content += `<tr>
              <td class="col-partner">${row.partner}</td>
              <td class="col-name">${row.isExchange ? '<span style="display:inline-block;background:#fef3c7;color:#92400e;font-size:9px;font-weight:900;padding:1px 5px;border-radius:4px;margin-right:4px;">交換希望</span>' : ''}<b>${row.name}</b><br><small>${row.spec}</small></td>
              <td class="col-expiry">${row.expiry}</td>
              <td class="col-qty">${row.qty}${row.unit}</td>
            </tr>`;
          });
          content += `</tbody></table></div>`;
        }
      });

      // ★追加：全店不動在庫の一括表示セクション
      if (allDeadStockItems.length > 0) {
        content += `<div class="page-break"></div>`; 
        content += `<div class="mt-4">
          <h2 class="text-lg font-bold bg-rose-600 text-white p-2 mb-4">● 全店不動在庫（自店処理分）一括リスト</h2>
          <p class="text-[10px] mb-2 text-rose-700 font-bold">※以下は引受先がなく、各在庫店舗にて処理が必要な医薬品です。</p>
          <table>
            <thead>
              <tr>
                <th class="col-partner">在庫店舗名</th>
                <th class="col-name">薬品名 / 規格</th>
                <th class="col-qty">数量</th>
                <th class="col-expiry">期限</th>
                <th class="col-lot">ロット番号</th>
              </tr>
            </thead>
            <tbody>`;
        
        allDeadStockItems.forEach(item => {
          content += `<tr>
            <td class="col-partner">${item.storeName}</td>
            <td class="col-name"><b>${item.name}</b><br> <small>${item.spec} / 製：${item.manufacturer} / 販：${item.distributor}</small> </td>
            <td class="col-qty">${item.qty}${item.unit}</td>
            <td class="col-expiry">${item.expiry}</td>
            <td class="col-lot">${item.lot}</td>
          </tr>`;
        });
        
        content += `</tbody></table></div>`;
      }
      // ★追加：全店交換希望品の一括表示セクション（目印用。出庫・不動の集計とは別に一覧化）
      const allExchangeItems = reportData.allStoresSummary.flatMap(summary =>
        summary.exchangeItems.flatMap(item => {
          const rows: any[] = [];
          item.assignments.forEach((a: any) => {
            rows.push({
              storeName: summary.storeName,
              name: item.name, spec: item.spec,
              manufacturer: item.manufacturer || '-',
              distributor: item.distributor || '-',
              lot: item.lot_number || '-',
              expiry: item.expiry_date,
              qty: a.qty,
              unit: item.unit,
              result: `${stores.find(s => s.id === a.storeId)?.name || '不明'}へ出庫`
            });
          });
          if (item.realDeadQty > 0) {
            rows.push({
              storeName: summary.storeName,
              name: item.name, spec: item.spec,
              manufacturer: item.manufacturer || '-',
              distributor: item.distributor || '-',
              lot: item.lot_number || '-',
              expiry: item.expiry_date,
              qty: item.realDeadQty,
              unit: item.unit,
              result: '不動処理'
            });
          }
          return rows;
        })
      ).sort((a, b) => {
        if (a.storeName !== b.storeName) return a.storeName.localeCompare(b.storeName, 'ja');
        if (a.expiry !== b.expiry) return (a.expiry || '').localeCompare(b.expiry || '');
        return a.name.localeCompare(b.name, 'ja');
      });

      if (allExchangeItems.length > 0) {
        content += `<div class="page-break"></div>`;
        content += `<div class="mt-4">
          <h2 class="text-lg font-bold bg-amber-500 text-white p-2 mb-4">● 全店交換希望（キープ品）内訳リスト ※出庫・不動リストと重複掲載</h2>
          <p class="text-[10px] mb-2 text-amber-700 font-bold">※以下はキープ希望が出ていた医薬品です。期限切れ回避を優先し、出庫・不動の処理は通常通り実施済みです。新しいロットとの交換は状況に応じて別途調整してください。</p>
          <table>
            <thead>
              <tr>
                <th class="col-partner">在庫店舗名</th>
                <th class="col-name">薬品名 / 規格</th>
                <th class="col-qty">数量</th>
                <th class="col-expiry">期限</th>
                <th class="col-lot">ロット番号</th>
                <th class="col-partner">処理結果</th>
              </tr>
            </thead>
            <tbody>`;

        allExchangeItems.forEach(item => {
          content += `<tr>
            <td class="col-partner">${item.storeName}</td>
            <td class="col-name"><b>${item.name}</b><br> <small>${item.spec} / 製：${item.manufacturer} / 販：${item.distributor}</small> </td>
            <td class="col-qty">${item.qty}${item.unit}</td>
            <td class="col-expiry">${item.expiry}</td>
            <td class="col-lot">${item.lot}</td>
            <td class="col-partner">${item.result}</td>
          </tr>`;
        });

        content += `</tbody></table></div>`;
      }
    } else {
      // 個別タブ印刷時も同様のフラット化・ソートを適用
      const currentStoreName = stores.find(s => s.id === currentStoreId)?.name || '全店モード';
      const titleMap = { shipping: '出庫リスト', receiving: '入庫リスト', dead: '不動在庫リスト', exchange: '交換希望リスト' };

      const flatList = reportData[activeTab].flatMap(item => {
        if (activeTab === 'dead') {
          return [{ partner: '自店', name: item.name, spec: item.spec, expiry: item.expiry_date, qty: item.realDeadQty, unit: item.unit }];
        }
        if (activeTab === 'exchange') {
          const rows: any[] = item.assignments.map((a: any) => ({
            partner: `${stores.find(s => s.id === a.storeId)?.name || '不明'}へ出庫`,
            name: item.name, spec: item.spec, expiry: item.expiry_date, qty: a.qty, unit: item.unit
          }));
          if (item.realDeadQty > 0) {
            rows.push({ partner: '不動処理', name: item.name, spec: item.spec, expiry: item.expiry_date, qty: item.realDeadQty, unit: item.unit });
          }
          return rows;
        }
        return item.assignments
          .filter((a: any) => isAllStores || (activeTab === 'receiving' ? a.storeId === currentStoreId : true))
          .map((a: any) => ({
            partner: activeTab === 'shipping' ? (stores.find(s => s.id === a.storeId)?.name || '不明') : (stores.find(s => s.id === item.store_id)?.name || '不明'),
            name: item.name, spec: item.spec, expiry: item.expiry_date, qty: a.qty, unit: item.unit,
            isExchange: activeTab === 'shipping' && item.is_locked
          }));
      }).sort((a, b) => {
        if (a.partner !== b.partner) return a.partner.localeCompare(b.partner, 'ja');
        if (a.expiry !== b.expiry) return a.expiry.localeCompare(b.expiry);
        return a.name.localeCompare(b.name, 'ja');
      });
      content += `<h1 class="text-xl font-bold mb-4">${currentStoreName} - ${titleMap[activeTab]}</h1>
        <table><thead><tr><th class="col-partner">関係店舗</th><th class="col-name">薬品名 / 規格</th><th class="col-expiry">期限</th><th class="col-qty">数量</th></tr></thead><tbody>`;
      flatList.forEach(row => {
          content += `<tr>
            <td class="col-partner">${row.partner}</td>
            <td class="col-name">${(row as any).isExchange ? '<span style="display:inline-block;background:#fef3c7;color:#92400e;font-size:9px;font-weight:900;padding:1px 5px;border-radius:4px;margin-right:4px;">交換希望</span>' : ''}<b>${row.name}</b><br><small>${row.spec}</small></td>
            <td class="col-expiry">${row.expiry}</td>
            <td class="col-qty">${row.qty}${row.unit}</td>
          </tr>`;
         });
          content += `</tbody></table>`;
         }

    content += `<script>window.onload=()=>{setTimeout(()=>{window.print();window.close();},500);};</script></body></html>`;
    printWindow.document.write(content);
    printWindow.document.close();
  };

 // --- 画面描画用：flatMapで多対多を分解表示 ---
  const renderList = (list: any[], type: 'shipping' | 'receiving' | 'dead' | 'exchange') => {
    // 1. まず全データをフラットな行(row)に展開する
    const rows = list.flatMap(item => {
      if (type === 'dead') {
        return [{ 
          partner: stores.find(s => s.id === item.store_id)?.name || '不明', 
          qty: item.realDeadQty, 
          name: item.name, spec: item.spec, expiry: item.expiry_date, 
          unit: item.unit, price: (item.total_amount * item.realDeadQty) / item.stock_total,
          key: `dead-${item.id}` 
        }];
      }
      if (type === 'exchange') {
        // 実際に動く数量（出庫先ごと＋不動分）を、目印としてすべて列挙する
        const rows: any[] = [];
        item.assignments.forEach((a: any, idx: number) => {
          const partnerName = stores.find(s => s.id === a.storeId)?.name || '不明';
          rows.push({
            partner: `${partnerName}（出庫・交換希望品）`,
            qty: a.qty,
            name: item.name, spec: item.spec, expiry: item.expiry_date,
            unit: item.unit, price: (item.total_amount * a.qty) / item.stock_total,
            key: `exchange-ship-${item.id}-${idx}`
          });
        });
        if (item.realDeadQty > 0) {
          rows.push({
            partner: '不動処理（交換希望品）',
            qty: item.realDeadQty,
            name: item.name, spec: item.spec, expiry: item.expiry_date,
            unit: item.unit, price: (item.total_amount * item.realDeadQty) / item.stock_total,
            key: `exchange-dead-${item.id}`
          });
        }
        return rows;
      }
      return item.assignments
        .filter((a: any) => isAllStores || (type === 'receiving' ? a.storeId === currentStoreId : true))
        .map((a: any, idx: number) => ({
          partner: type === 'shipping' ? (stores.find(s => s.id === a.storeId)?.name || '不明') : (stores.find(s => s.id === item.store_id)?.name || '不明'),
          qty: a.qty,
          name: item.name, spec: item.spec, expiry: item.expiry_date,
          unit: item.unit, price: (item.total_amount * a.qty) / item.stock_total,
          key: `${type}-${item.id}-${idx}`
        }));
    });

    // 2. 展開された行に対して「店舗名 > 期限 > 薬品名」で最終ソート
    const sortedRows = rows.sort((a, b) => {
      if (a.partner !== b.partner) return a.partner.localeCompare(b.partner, 'ja');
      if (a.expiry !== b.expiry) return a.expiry.localeCompare(b.expiry);
      return a.name.localeCompare(b.name, 'ja');
    });

    return (
      <div className="space-y-3">
        {/* --- デスクトップ用：テーブル表示 (md以上) --- */}
        <div className="hidden md:block bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden">
      <table className="w-full text-left">
        <thead className="bg-slate-50">
          <tr>
            <th className="p-4 text-[11px] font-black text-slate-400 uppercase w-40">
              {type === 'shipping' ? '分譲先' : type === 'receiving' ? '提供元' : type === 'exchange' ? '内訳' : '所在店舗'}
            </th>
            <th className="p-4 text-[11px] font-black text-slate-400 uppercase">薬品名 / 規格</th>
            <th className="p-4 text-[11px] font-black text-slate-400 uppercase text-center w-24">期限</th>
            <th className="p-4 text-[11px] font-black text-slate-400 uppercase text-right w-24">数量</th>
            <th className="p-4 text-[11px] font-black text-slate-400 uppercase text-right w-32">確定金額</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
                      {sortedRows.map(row => (
              <tr key={row.key} className="hover:bg-slate-50/50">
                <td className="p-4">
                    <span className={`px-2 py-1 rounded-lg text-[10px] font-bold ${type === 'dead' ? 'bg-rose-50 text-rose-600' : type === 'exchange' ? 'bg-amber-50 text-amber-600' : 'bg-blue-50 text-blue-600'}`}>
                      {row.partner}
                    </span>
                </td>
                <td className="p-4">
                  <div className="font-bold text-sm text-slate-800">{row.name}</div>
                  <div className="text-[10px] text-slate-400">{row.spec}</div>
                </td>
                <td className="p-4 text-center text-[11px] font-black text-slate-600 whitespace-nowrap">{row.expiry}</td>
                <td className="p-4 text-right font-black text-slate-700">{row.qty} <small>{row.unit}</small></td>
                <td className="p-4 text-right font-mono text-sm">¥{Math.round(row.price).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

        {/* --- スマホ用：カード表示 (md未満) --- */}
        <div className="md:hidden space-y-3">
          {sortedRows.map(row => (
            <div key={row.key} className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm active:bg-slate-50 transition-colors">
              <div className="flex justify-between items-start mb-2">
                <span className={`px-2 py-0.5 rounded-md text-[10px] font-black tracking-wider ${type === 'dead' ? 'bg-rose-100 text-rose-700' : type === 'exchange' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>
                  {row.partner}
                </span>
                <span className="text-[10px] font-mono text-slate-400 bg-slate-50 px-1.5 rounded">{row.expiry}</span>
              </div>
              <div className="font-bold text-[14px] text-slate-800 leading-tight mb-1">{row.name}</div>
              <div className="text-[11px] text-slate-500 mb-3">{row.spec}</div>
              <div className="flex justify-between items-end pt-2 border-t border-slate-50">
                <div className="text-left">
                  <div className="text-[8px] text-slate-400 uppercase font-black mb-0.5">確定金額</div>
                  <div className="text-xs font-bold text-slate-600 font-mono">¥{Math.round(row.price).toLocaleString()}</div>
                </div>
                <div className="text-right">
                  <div className="text-[8px] text-slate-400 uppercase font-black mb-0.5">数量</div>
                  <div className="text-lg font-black text-blue-600 tabular-nums">
                    {row.qty} <span className="text-xs font-bold">{row.unit}</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
          {sortedRows.length === 0 && (
            <div className="py-20 text-center text-slate-300 font-black uppercase tracking-widest text-xs">
              該当データがありません
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full space-y-4 md:space-y-6 px-1 md:px-0">
      {/* タブメニュー：スマホでは隙間を詰め、パディングを調整 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
        {[
          { id: 'shipping', label: '出庫', color: 'blue', icon: ArrowUpRight, total: reportData.totals.shipping },
          { id: 'receiving', label: '入庫', color: 'emerald', icon: ArrowDownLeft, total: reportData.totals.receiving },
          { id: 'exchange', label: '交換希望', color: 'amber', icon: Repeat, total: reportData.totals.exchange },
          { id: 'dead', label: '不動', color: 'rose', icon: Trash2, total: reportData.totals.dead }
        ].map((tab) => {
          const colorClass = tab.color === 'blue' ? 'blue' : tab.color === 'emerald' ? 'emerald' : tab.color === 'amber' ? 'amber' : 'rose';
          return (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`p-3 md:p-4 rounded-2xl md:rounded-3xl border text-left transition-all ${
              activeTab === tab.id 
                ? `bg-${colorClass}-600 text-white shadow-lg border-transparent` 
                : 'bg-white border-slate-100 text-slate-400'
            }`}
          >
            <tab.icon size={18} className={activeTab === tab.id ? 'text-white' : `text-${colorClass}-500`} />
            <div className="mt-1 md:mt-2">
              <div className="text-[9px] md:text-[10px] font-black uppercase opacity-80">{tab.label}</div>
              <div className="text-[10px] md:text-sm font-black truncate">
                ¥{Math.round(tab.total).toLocaleString()}
              </div>
            </div>
          </button>
          );
        })}
      </div>

      {/* メインリストエリア：スマホでのスクロール体験を向上 */}
      <div className="flex-1 overflow-y-auto pr-1">
        {renderList(reportData[activeTab], activeTab)}
      </div>

      {/* アクションボタン：スマホでは縦にスタック、PCでは横並び */}
      <div className="flex flex-col sm:flex-row justify-end gap-3 md:gap-4 pt-2 md:pt-4">
        <button 
          onClick={() => handlePrintAction('single')} 
          className="flex items-center justify-center gap-2 bg-slate-800 text-white px-6 py-3.5 md:py-3 rounded-2xl font-bold hover:bg-slate-900 shadow-md active:scale-95 transition-all w-full sm:w-auto"
        >
          <Printer size={18} /> 
          <span className="text-sm">表示中のタブを印刷</span>
        </button>
        <button 
          onClick={() => handlePrintAction('all')} 
          className="flex items-center justify-center gap-2 bg-blue-700 text-white px-6 py-3.5 md:py-3 rounded-2xl font-bold hover:bg-blue-800 shadow-md active:scale-95 transition-all w-full sm:w-auto"
        >
          <Calculator size={18} /> 
          <span className="text-sm">全店一括印刷 (指示書)</span>
        </button>
      </div>
    </div>
  );
};

export default FinalDetermination;