// @ts-ignore - Deno runtime global
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// --- 共通ヘルパー ---
const toNum = (val: string) => {
  if (!val) return 0;
  const cleaned = val.replace(/^"|"$/g, '').replace(/,/g, '');
  return Number(cleaned) || 0;
};
// 単位の表記ゆれを統一（ｇ/Ｇ/g、Ｃ/C/カプセル、ｷｯ/ｷｯﾄ/キット、mL/ＭＬ など）
// NFKC = 全角英数→半角、半角カナ→全角カナ に揃えるUnicode標準の変換
const UNIT_ALIAS: Record<string, string> = {
  'カプセル': 'C', 'CAP': 'C', 'キッ': 'キット', 'シー': 'シート', 'グラム': 'G', 'CC': 'ML',
};
const normUnit = (u: string): string => {
  const k = (u || '').normalize('NFKC').replace(/\s/g, '').toUpperCase();
  return UNIT_ALIAS[k] || k;
};

// 薬品名末尾の「(ﾁｭｰﾌﾞ25ｇ)」「(PTP1錠)」「(枚7枚)」から、1個あたりの内容量と単位を取り出す
const parseContent = (name: string): { amount: number, unit: string } => {
  const n = (name || '').normalize('NFKC').trim();
  const m = n.match(/([0-9][0-9,]*(?:\.[0-9]+)?)\s*([^0-9()\s]+)\)$/);
  if (!m) return { amount: 1, unit: '' };
  return { amount: Number(m[1].replace(/,/g, '')) || 1, unit: normUnit(m[2]) };
};

// 規格「100錠入り」「10本入り」「1,000錠入り」から、1箱あたりの入数と単位を取り出す
const parsePack = (spec: string): { size: number, unit: string } => {
  const m = (spec || '').normalize('NFKC').match(/([0-9][0-9,]*(?:\.[0-9]+)?)\s*([^0-9\s]*)/);
  if (!m) return { size: 1, unit: '' };
  return { size: Number(m[1].replace(/,/g, '')) || 1, unit: normUnit(m[2].replace(/入り?$/, '')) };
};

const roundQty = (n: number) => Math.round(n * 10000) / 10000;

/**
 * 入庫数を、在庫一覧と同じ数え方（錠・ｇ・mL・枚など）に換算する
 *  ・箱：      入庫数 × 入数 × 1個あたりの内容量（例 2箱 × 10本 × 25ｇ = 500ｇ）
 *  ・本/袋/包：入庫数 × 1個あたりの内容量        （例 2本 × 25ｇ = 50ｇ）
 *  ・錠/ｇ/mL：すでにバラ数なので換算しない       （例 (ﾁｭｰﾌﾞ25ｇ) の 125ｇ = 125ｇ）
 */
const toStockQty = (qty: number, unit: string, name: string, spec: string): number => {
  const content = parseContent(name);
  let count = qty;
  let countUnit = normUnit(unit);
  // 規格（○○入り）があるのは箱単位の入庫。入数を掛けて「10本」「100錠」などに直す
  if (countUnit === '箱' && spec) {
    const pack = parsePack(spec);
    count = qty * pack.size;
    countUnit = pack.unit;
  }
  // 数えている単位が内容量の単位と同じなら、すでにバラ数になっている
  if (countUnit && countUnit === content.unit) return roundQty(count);
  return roundQty(count * content.amount);
};

// 薬価コードなどのクレンジング（スペース除去、文字列化）
const cleanCode = (val: any) => (val || '').toString().replace(/^"|"$/g, '').trim();

// 名称の正規化（全角半角・空白・ハイフン類の違いを吸収）
const normalize = (val: string) => (val || '')
  .normalize('NFKC')
  .toUpperCase()
  .replace(/\s/g, '')
  .replace(/[‐‑–—―−]/g, '-');

// JAN(13桁)とGS1(14桁)は先頭と末尾（チェック数字）が異なるため、共通の12桁で照合する
const janKey = (code: string): string => {
  const c = (code || '').trim();
  if (/^\d{14}$/.test(c)) return c.slice(1, 13);
  if (/^\d{13}$/.test(c)) return c.slice(0, 12);
  return '';
};

// 包装の照合キー（南森町形式：同じ商品名でも「ＰＴＰ/100」「バラ/1,000」等が別行になるため）
const makePackKey = (type: string, size: string): string =>
  `${normalize(type)}|${toNum(size) || ''}`;

// 仕入先が卸ではなく他の薬局（分譲・店舗間移動）か。画面側 orderMatch.ts の isTransferSupplier と同じ条件
const isTransferSupplier = (s: string): boolean =>
  /分譲|譲受|薬局|他店|移管|譲渡/.test((s || '').normalize('NFKC'));

const splitCsvLine = (line: string): string[] => {
  const result: string[] = [];
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

const getIdx = (headers: string[], keywords: string[], fallback: number) => {
  // 1. まず完全一致を探す（これで「単位」が「規格単位」に吸われるのを防ぐ）
  const exact = headers.findIndex(h => keywords.some(k => h === k));
  if (exact !== -1) return exact;
  // 2. なければ部分一致
  const partial = headers.findIndex(h => keywords.some(k => h.includes(k)));
  return partial === -1 ? fallback : partial;
};

const toDate = (val: string) => {
  if (!val) return null;
  let s = val.replace(/^"|"$/g, '').trim().replace(/[\/\.]/g, '-');

  // 1. YYYY-MM-DD または YY-MM-DD
  const dateMatch = s.match(/^(\d{2,4})-(\d{1,2})-(\d{1,2})$/);
  if (dateMatch) {
    let [_, y, m, d] = dateMatch;
    y = y.length === 2 ? `20${y}` : y;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // 2. YYYY-MM (月まで) の場合、月末日を補完
  const monthMatch = s.match(/^(\d{2,4})-(\d{1,2})$/);
  if (monthMatch) {
    let [_, y, m] = monthMatch;
    y = y.length === 2 ? `20${y}` : y;
    const lastDay = new Date(Number(y), Number(m), 0).getDate();
    return `${y}-${m.padStart(2, '0')}-${lastDay}`;
  }

  // 3. YYYYMMDD (8桁)
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }

  return null;
};

const generateKey = (yj: string, lot: string, expiry: string) => 
  `${yj}_${lot || '不明'}_${expiry ||'9999-12-31'}`;

// --- 入庫履歴（期限管理用）の処理 ---
async function processPurchaseHistoryMode(csvText: string, store_id: string, SUPABASE_URL: string, SERVICE_KEY: string) {
  const now = new Date().toISOString(); // インポート実行時のタイムスタンプ
  const cleanText = csvText.replace(/\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const allLines = cleanText.split('\n').filter(l => l.trim() !== '');
  if (allLines.length < 1) throw new Error("データが空です");

  let headerIdx = -1;
  let headers: string[] = [];
  for (let i = 0; i < Math.min(allLines.length, 10); i++) {
    const cols = splitCsvLine(allLines[i]);
    if (cols.some(c => c.includes('ﾛｯﾄNo') || c.includes('製造番号') || c.includes('有効年') || c.includes('使用期限'))) {
      headerIdx = i;
      headers = cols.map(h => h.replace(/^"|"$/g, '').trim());
      break;
    }
  }
  if (headerIdx === -1) throw new Error("入庫履歴のヘッダー行が見つかりません。");

  const idx = {
    date: getIdx(headers, ['日付', '入庫日'], 0),
    name: getIdx(headers, ['薬品名', '商品名'], 2),
    qty: getIdx(headers, ['入庫数', '数量'], 5),
    lot: getIdx(headers, ['ﾛｯﾄNo', '製造番号'], 11),
    expiry: getIdx(headers, ['有効年', '使用期限'], 12),
    yCode: getIdx(headers, ['JANコード', 'GS1/JAN', 'YCODE', '厚生省ｺｰﾄﾞ', '厚生省コード'], 15)
  };
  // JANが空欄の行は厚生省コード等で代用する（空欄のままだと別の薬品同士が合算されてしまう）
  const altCodeIdx = ['JANコード', 'GS1/JAN', '厚生省ｺｰﾄﾞ', '厚生省コード', 'YCODE']
    .map(k => headers.indexOf(k)).filter(i => i !== -1);
  const specIdx = headers.indexOf('規格');
  const unitIdx = headers.indexOf('単位');
  const supplierIdx = ['仕入先名', '仕入先', '発注先'].map(k => headers.indexOf(k)).find(i => i !== -1) ?? -1;
  const packIdx = headers.indexOf('包装単位総量'); // 南森町形式（右隣の無題列が総量）

  const rowsMap = new Map<string, any>();
  for (let i = headerIdx + 1; i < allLines.length; i++) {
    const cols = splitCsvLine(allLines[i]);
    if (cols.length <= Math.max(...Object.values(idx))) continue;

    const boxQty = toNum(cols[idx.qty]); // CSVの入庫数（箱数や本数)
    const rawName = cols[idx.name]?.replace(/^"|"$/g, '').trim();
    if (!rawName || boxQty === 0) continue;

    // --- ここで在庫と同じ数え方に換算 ---
    // 南森町形式（規格・単位の列なし）の数量は、すでにバラ数なので換算しない
    const totalUnitQty = unitIdx === -1 && specIdx === -1
      ? boxQty
      : toStockQty(
          boxQty,
          unitIdx !== -1 ? cleanCode(cols[unitIdx]) : '箱',
          rawName,
          specIdx !== -1 ? cleanCode(cols[specIdx]) : ''
        );

    const purchaseDate = toDate(cols[idx.date]) || now.split('T')[0];
    let yakkaCode = cleanCode(cols[idx.yCode]);
    for (const i of altCodeIdx) {
      if (yakkaCode) break;
      yakkaCode = cleanCode(cols[i]);
    }
    const lotNumber = cleanCode(cols[idx.lot]) || 'LOT不明';

    
    // 発注との照合に使う納品箱数（箱数を確定できない本・錠などの単位は null）
    // 「届いた事実」を見るためのものなので、返品（マイナス）は差し引かない
    const packTotal = packIdx !== -1 ? toNum(cols[packIdx + 1]) : 0;
    const rowSupplier = supplierIdx !== -1 ? cleanCode(cols[supplierIdx]) : '';
    const rowBoxQty = boxQty < 0 ? 0 : packTotal > 0
      ? roundQty(boxQty / packTotal)                                      // 南森町形式：数量 ÷ 1箱の総量
      : unitIdx !== -1 && normUnit(cleanCode(cols[unitIdx])) === '箱' ? boxQty // 天六形式：単位が箱なら入庫数のまま
      : null;

    // 数量(qty)をキーから外し、同一納品として集約する
    const compositeKey = `${purchaseDate}_${yakkaCode}_${lotNumber}`;

    if (rowsMap.has(compositeKey)) {
      // すでに同じキーがあれば、数量を合算する
      const existing = rowsMap.get(compositeKey);
      existing.quantity = roundQty(existing.quantity + totalUnitQty);
      // 同じ日・同じロットに卸と他店の入庫が混在する場合、仕入先と箱数は卸の分だけを採用する
      // （期限・ロット用の quantity は全部を合算したまま）。返品行の仕入先は採用しない
      if (boxQty > 0) {
        const isEmpty = existing.supplier === null && existing.box_qty === 0; // ここまで返品行だけ
        const wasTransfer = isTransferSupplier(existing.supplier || '');
        const isTransfer = isTransferSupplier(rowSupplier);
        if (isEmpty || (wasTransfer && !isTransfer)) {
          existing.supplier = rowSupplier || null;
          existing.box_qty = rowBoxQty;
        } else if (wasTransfer === isTransfer) {
          existing.box_qty = existing.box_qty === null || rowBoxQty === null ? null : roundQty(existing.box_qty + rowBoxQty);
          if (rowSupplier && !(existing.supplier || '').split('/').includes(rowSupplier)) {
            existing.supplier = existing.supplier ? `${existing.supplier}/${rowSupplier}` : rowSupplier;
          }
        }
      }
      if (!existing.expiry_date) existing.expiry_date = toDate(cols[idx.expiry]);
      existing.updated_at = now;
    } else {
      rowsMap.set(compositeKey, {
        store_id,
        purchase_date: purchaseDate,
        yakka_code: yakkaCode,
        name: rawName,
        lot_number: lotNumber,
        expiry_date: toDate(cols[idx.expiry]),
        quantity: totalUnitQty,
        box_qty: rowBoxQty,
        supplier: boxQty > 0 ? rowSupplier || null : null,
        pack_key: packIdx !== -1 ? makePackKey(cols[packIdx], cols[packIdx + 1]) : null,
        updated_at: now
      });
    }
  }

  const historyRows = Array.from(rowsMap.values());
  if (historyRows.length === 0) throw new Error("有効なデータが見つかりませんでした。");

  // 1. 入庫履歴の保存（バッチ処理 500件ずつ）
  const BATCH_SIZE = 500;
  // 追加SQLが未実行で列が無いDBでも取り込めるよう、存在しない列は外して送り直す
  const optionalCols = new Set(['pack_key', 'box_qty', 'supplier']);
  const missingCols = new Set<string>();
  for (let i = 0; i < historyRows.length; i += BATCH_SIZE) {
    const batch = historyRows.slice(i, i + BATCH_SIZE);
    const postBatch = () => fetch(`${SUPABASE_URL}/rest/v1/purchase_history?on_conflict=store_id,purchase_date,yakka_code,lot_number`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify(batch.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => !missingCols.has(k)))))
    });
    let historyRes = await postBatch();
    while (!historyRes.ok) {
      const errText = await historyRes.text();
      const missing = [...optionalCols].find(c => !missingCols.has(c) && errText.includes(c));
      if (!missing) throw new Error(`入庫履歴の保存失敗(${i}件目〜): ${errText}`);
      missingCols.add(missing);
      historyRes = await postBatch();
    }
  }

  // 在庫側の期限・ロット内訳は、続けて行う「STEP2 現在庫同期」で全件計算し直す
  return { success: true, count: historyRows.length };
}

// --- 期限・ロットの引き当て ---
// 同じ納品が「コードあり」と「コードなし（旧取込分）」の両方で残っている場合、コードありを採用する
const codeRank = (code: string) => janKey(code) ? 2 : code ? 1 : 0;

const prepareHistory = (rows: any[]): any[] => {
  const groupKey = (h: any) => `${h.purchase_date}_${normalize(h.name)}_${h.lot_number}`;
  const best = new Map<string, number>();
  for (const h of rows) {
    const k = groupKey(h);
    best.set(k, Math.max(best.get(k) ?? 0, codeRank(h.yakka_code)));
  }
  const list = rows
    .filter(h => codeRank(h.yakka_code) === best.get(groupKey(h)))
    .map(h => ({ ...h, quantity: Number(h.quantity) || 0 }));

  // 納品日の新しい順。同日なら期限の長いものを新しい在庫とみなす
  list.sort((a, b) =>
    (b.purchase_date || '').localeCompare(a.purchase_date || '') ||
    (b.expiry_date || '').localeCompare(a.expiry_date || ''));

  // 返品（マイナス入庫）は、同じ薬品・同じロットの直近の納品から差し引く
  const byLot = new Map<string, any[]>();
  for (const h of list) {
    const k = `${normalize(h.name)}_${h.lot_number}`;
    if (!byLot.has(k)) byLot.set(k, []);
    byLot.get(k)!.push(h);
  }
  for (const group of byLot.values()) {
    for (const ret of group.filter(h => h.quantity < 0)) {
      let back = -ret.quantity;
      for (const h of group) {
        if (back <= 0) break;
        if (h.quantity <= 0 || h.purchase_date > ret.purchase_date) continue;
        const cut = Math.min(back, h.quantity);
        h.quantity = roundQty(h.quantity - cut);
        back = roundQty(back - cut);
      }
      ret.quantity = 0;
    }
  }
  return list.filter(h => h.quantity > 0);
};

/**
 * 入庫履歴1件ごとに「どの在庫行のものか」を決めて、新しい順に在庫へ割り当てる。
 * 1件の入庫が複数の在庫行で二重に数えられないよう、割り当てた分は減らしていく。
 *  照合順：JANコード → 厚生省コード → 薬品名（同名が複数あれば包装も照合）
 */
const allocateLots = (stocks: any[], history: any[]) => {
  const index = (map: Map<string, any[]>, key: string, v: any) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    if (!map.get(key)!.includes(v)) map.get(key)!.push(v);
  };
  const byJan = new Map<string, any[]>();
  const byYj = new Map<string, any[]>();
  const byName = new Map<string, any[]>();
  for (const s of stocks) {
    s.remaining = Math.max(0, s.stockQty);
    s.details = [];
    s.jans.forEach((j: string) => index(byJan, janKey(j), s));
    index(byYj, s.yakka, s);
    index(byName, normalize(s.name), s);
  }

  for (const h of prepareHistory(history)) {
    const name = normalize(h.name);
    let owners = byJan.get(janKey(h.yakka_code)) || [];
    if (owners.length === 0) {
      // 同じコードで包装違いの行がある場合は、名前まで一致する行を優先
      const yj = byYj.get(h.yakka_code) || [];
      const yjSameName = yj.filter(s => normalize(s.name) === name);
      owners = yjSameName.length > 0 ? yjSameName : yj;
    }
    if (owners.length === 0) owners = byName.get(name) || [];
    if (owners.length > 1 && h.pack_key) {
      const samePack = owners.filter(s => s.packKey === h.pack_key);
      if (samePack.length > 0) owners = samePack;
    }

    let left = h.quantity;
    for (const s of [...owners].sort((a, b) => b.remaining - a.remaining)) {
      const take = roundQty(Math.min(left, s.remaining));
      if (take <= 0) continue;
      s.details.push({
        lot: h.lot_number || '不明',
        expiry: h.expiry_date || '9999-12-31',
        qty: take,
        purchase_date: h.purchase_date
      });
      s.remaining = roundQty(s.remaining - take);
      left = roundQty(left - take);
    }
  }

  // 納品履歴をすべて足しても在庫数に満たない場合、不足分を「不明」として追加
  for (const s of stocks) {
    if (s.details.length > 0 && s.remaining > 0) {
      s.details.push({ lot: '不明（履歴不足）', expiry: '9999-12-31', qty: s.remaining, purchase_date: null });
    }
  }
};

/**
 * リアルタイム在庫（レセコンデータ）専用の処理
 */
async function processRealtimeMode(csvText: string, store_id: string, SUPABASE_URL: string, SERVICE_KEY: string) {
  const now = new Date().toISOString();
  // 1. 入庫履歴を全件取得（Supabaseは1回に最大1000件しか返さないため、無くなるまで繰り返し取得する）
  const allHistory: any[] = [];
  while (true) {
    const historyRes = await fetch(`${SUPABASE_URL}/rest/v1/purchase_history?store_id=eq.${encodeURIComponent(store_id)}&order=purchase_date.desc,id.desc&limit=1000&offset=${allHistory.length}`, {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }
    });
    if (!historyRes.ok) throw new Error(`入庫履歴の取得失敗: ${await historyRes.text()}`);
    const page = await historyRes.json();
    if (page.length === 0) break;
    allHistory.push(...page);
  }

  const cleanText = csvText.replace(/\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const allLines = cleanText.split('\n').filter(l => l.trim() !== '');  
  if (allLines.length < 1) throw new Error("データが空です");

    // ヘッダー行の解析
  const headers = splitCsvLine(allLines[0]).map(h => h.replace(/^"|"$/g, '').trim());
  
  let idx: { yj: number, name: number, spec: number, stock: number, unit: number };
  // --- 形式判定とインデックス割り当て ---
  const isTenrokuFormat = headers.includes('薬品ｺｰﾄﾞ') && headers.includes('厚生省ｺｰﾄﾞ');
  const isMinamimorimachiFormat = headers.includes('商品名') && headers.includes('現在庫');

  if (isTenrokuFormat) {
    // 【天六店形式：在庫一覧.txt】
    idx = {
      yj: 16,   // 厚生省コード
      name: 3,  // 薬品名
      spec: 4,  // 規格
      stock: 9, // 在庫数
      unit: 11  // 単位
    };
  } else if (isMinamimorimachiFormat) {
    // 【南森町店形式：在庫一覧_...csv】
    idx = {
      yj: -1,   // CSVにYJコード列がないため名称マッチング
      name: 1,  // 商品名
      spec: 2,  // 包装単位総量（調剤用、PTP等）
      stock: 4, // 現在庫
      unit: 7   // 単位（Ｇ、錠等）
    };
  } else {
    // 【汎用形式：いずれにも該当しない場合】
    // フォールバックに特定の列番号を指定せず、キーワードが見つからない場合は -1 を返す
    idx = {
      yj: getIdx(headers, ['厚生省コード', '厚生省ｺｰﾄﾞ', '薬価コード', 'コード'], -1),
      name: getIdx(headers, ['薬品名', '商品名', '名称'], -1),
      spec: getIdx(headers, ['規格', '包装形態', '包装単位総量'], -1),
      stock: getIdx(headers, ['在庫数', '現在庫', '在庫数合計'], -1),
      unit: getIdx(headers, ['単位'], -1)
    };
    
    // 必須項目（薬品名・在庫数）が見つからない場合はエラー
    if (idx.name === -1 || idx.stock === -1) {
      throw new Error("不明なファイル形式です。");
    }
  }

  // JANコード列（天六店形式は見出しの無い18列目に「;」区切りで入っている）
  const janHeaderIdx = headers.findIndex(h => h.includes('JAN'));

  // 在庫0の行も、入庫履歴が別の行へ誤って割り当てられないよう照合には含める
  const stocks = allLines.slice(1).map(line => {
    const cols = splitCsvLine(line);
    if (cols.length <= Math.max(...Object.values(idx))) return null;
    const name = cleanCode(cols[idx.name]);
    if (!name) return null;
    const janCols = janHeaderIdx !== -1 ? [cols[janHeaderIdx]] : cols.slice(headers.length);
    return {
      name,
      yakka: idx.yj !== -1 ? cleanCode(cols[idx.yj]) : '',
      spec: idx.spec !== -1 ? cleanCode(cols[idx.spec]) : '',
      unit: idx.unit !== -1 ? cleanCode(cols[idx.unit]) : '',
      stockQty: toNum(cols[idx.stock]),
      jans: janCols.join(';').split(';').map(cleanCode).filter(Boolean),
      packKey: isMinamimorimachiFormat ? makePackKey(cols[2], cols[3]) : '',
    } as any;
  }).filter(Boolean) as any[];

  allocateLots(stocks, allHistory);

  const realtimeRows = stocks.filter(s => s.stockQty !== 0).map(s => ({
    store_id,
    yakka_code: s.yakka,
    name: s.name,
    spec: s.spec,
    stock_qty: s.stockQty,
    unit: s.unit,
    // 代表期限：割り当てたロットの中で「最も期限が近いもの」
    expiry_date: s.details.reduce((min: string, d: any) => (d.expiry < min ? d.expiry : min), '9999-12-31'),
    expiry_details: s.details,
    stock_updated_at: now,
    updated_at: now
  }));

    if (realtimeRows.length === 0) {
    throw new Error("有効な在庫データが見つかりませんでした。ファイル形式を確認してください。");
  }

  // 削除
  await fetch(`${SUPABASE_URL}/rest/v1/realtime_stocks?store_id=eq.${encodeURIComponent(store_id)}`, {
    method: 'DELETE',
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }
  });

  // 100件ずつ送信してタイムアウトを回避
  const CHUNK_SIZE = 100;
  for (let i = 0; i < realtimeRows.length; i += CHUNK_SIZE) {
    const chunk = realtimeRows.slice(i, i + CHUNK_SIZE);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/realtime_stocks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify(chunk)
    });
    if (!res.ok) throw new Error(`在庫挿入失敗: ${await res.text()}`);
  }

  return { success: true, count: realtimeRows.length };
}

/**
 * 【聖域】既存の棚卸ロジック
 */
async function processInventoryMode(csvText: string, store_id: string, SUPABASE_URL: string, SERVICE_KEY: string) {
    const cleanText = csvText.replace(/\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const allLines = cleanText.split('\n').filter(l => l.trim() !== '');
    if (allLines.length < 1) throw new Error('CSV empty');

    let headerIdx = -1; let headers: string[] = [];
    for (let i = 0; i < Math.min(allLines.length, 10); i++) {
      const cols = splitCsvLine(allLines[i]);
      if (cols.some(c => c.includes('個別医薬品コード') || c.includes('薬品名'))) {
        headerIdx = i;
        headers = cols.map(h => h.replace(/^"|"$/g, '').trim());
        break;
      }
    }

    const idx = {
      gs1: getIdx(headers, ['GS1コード'], 0),
      jan: getIdx(headers, ['JANコード'], 1),
      yj: getIdx(headers, ['個別医薬品コード', '薬価基準収載医薬品コード'], 3),
      manufacturer: getIdx(headers, ['製造会社'], 5), 
      distributor: getIdx(headers, ['販売会社'], 6),
      name: getIdx(headers, ['薬品名'], 7),
      spec: getIdx(headers, ['規格単位'], 8),
      lot: getIdx(headers, ['製造番号'], 11),
      expiry: getIdx(headers, ['使用期限'], 12),
      stock: getIdx(headers, ['在庫数合計'], 16),
      unit: headers.indexOf('単位') === -1 ? 17 : headers.indexOf('単位'),
      amount: getIdx(headers, ['在庫金額'], 19)
    };

    const fetchUrl = `${SUPABASE_URL}/rest/v1/inventory_items?select=id,yakka_code,lot_number,expiry_date,stock_total,is_dead_stock,dead_stock_flag_date,is_locked,dead_stock_qty,requested_amounts,adopting_store_ids&store_id=eq.${encodeURIComponent(store_id)}`;
    // 1回の取得は最大1000件のため、無くなるまで繰り返し取得する
    const existing: any[] = [];
    while (true) {
      const existingRes = await fetch(`${fetchUrl}&order=id&limit=1000&offset=${existing.length}`, { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } });
      // 取得できないまま進めると、設定の消失や重複登録になるため中止する
      if (!existingRes.ok) throw new Error(`既存の棚卸データの取得に失敗: ${await existingRes.text()}`);
      const page = await existingRes.json();
      if (page.length === 0) break;
      existing.push(...page);
    }
    const flagHistory = new Map<string, any>();
    for (const r of existing) {
      const key = generateKey(r.yakka_code, r.lot_number, r.expiry_date);
      flagHistory.set(key, r);
    }

    const rowsMap = new Map<string, any>();
    const newKeys = new Set<string>();

    for (let i = headerIdx + 1; i < allLines.length; i++) {
      const cols = splitCsvLine(allLines[i]);
      if (cols.length <= Math.max(...Object.values(idx))) continue;
      const stock = toNum(cols[idx.stock]);
      if (stock <= 0) continue; 
      const yj = (cols[idx.yj] || '').replace(/^"|"$/g,'');
      const name = (cols[idx.name] || '').replace(/^"|"$/g,'');
      const lot = (cols[idx.lot] || '不明').replace(/^"|"$/g,'');
      const expiry = toDate(cols[idx.expiry])||`未設定`;
      if (!yj || !name) continue;
      const key = generateKey(yj, lot, expiry);
      newKeys.add(key);
      if (rowsMap.has(key)) {
        const existingRow = rowsMap.get(key);
        existingRow.stock_total += stock;
        existingRow.total_amount += toNum(cols[idx.amount]);
      } else {
        // 【重要】この時点ではまだフラグを確定させない（同一キーの行が後続にもあり、
        // stock_totalがまだ集約途中のため）。集約完了後に一括で判定する。
        rowsMap.set(key, {
          store_id,
          yakka_code: yj,
          gs1_code: (cols[idx.gs1] || '').replace(/^"|"$/g,''), 
          jan_code: (cols[idx.jan] || '').replace(/^"|"$/g,''),
          manufacturer: (cols[idx.manufacturer] || '').replace(/^"|"$/g,''),
          distributor: (cols[idx.distributor] || '').replace(/^"|"$/g,''),
          name: name,
          spec: (cols[idx.spec] || '').replace(/^"|"$/g,''),
          unit: (cols[idx.unit] || '').replace(/^"|"$/g,''),
          lot_number: lot,
          expiry_date: expiry,
          stock_total: stock,
          total_amount: toNum(cols[idx.amount]),
          updated_at: new Date().toISOString()
        });
      }
    }

    // 【フラグ判定】集約が完了した最終的なstock_totalと、前回インポート時の値を比較する。
    // ・在庫数量が全く同じ → 同じ棚卸データを誤って再取込みしただけとみなし、フラグを維持
    // ・在庫数量が変わっている → 実際の棚卸更新とみなし、フラグ（不動・キープ・不要数量・
    //   引受情報など）は全てリセットする（半年に一度の棚卸で、前回設定したフラグは
    //   基本的に意味を持たなくなっているため）
    for (const [key, row] of rowsMap.entries()) {
      const history = flagHistory.get(key);
      const isUnchanged = history != null && Number(history.stock_total) === Number(row.stock_total);

      if (isUnchanged) {
        row.is_dead_stock = history.is_dead_stock || false;
        row.dead_stock_flag_date = history.dead_stock_flag_date || null;
        row.is_locked = history.is_locked || false;
        row.dead_stock_qty = history.dead_stock_qty ?? null;
        row.requested_amounts = history.requested_amounts || {};
        row.adopting_store_ids = history.adopting_store_ids || [];
      } else {
        row.is_dead_stock = false;
        row.dead_stock_flag_date = null;
        row.is_locked = false;
        row.dead_stock_qty = null;
        row.requested_amounts = {};
        row.adopting_store_ids = [];
      }
    }

    // 1件も読み取れないファイルで、既存の在庫を全て削除してしまわないように中止する
    if (rowsMap.size === 0) throw new Error('有効な棚卸データが見つかりませんでした。ファイル形式を確認してください。');

    // 既存の行はid指定で更新、それ以外は新規登録する。
    // （1回の送信では全行の列を揃える必要があるため、更新と新規を分けて送る）
    const updateRows: any[] = [];
    const insertRows: any[] = [];
    const keptIds = new Set<string>();
    for (const [key, row] of rowsMap.entries()) {
      const history = flagHistory.get(key);
      if (history) {
        keptIds.add(history.id);
        updateRows.push({ id: history.id, ...row });
      } else {
        insertRows.push(row);
      }
    }
    const toDeleteIds: string[] = existing.filter((r: any) => !keptIds.has(r.id)).map((r: any) => r.id);

    const BATCH_SIZE = 100;
    const saveRows = async (rows: any[], query: string, prefer: string, label: string) => {
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/inventory_items${query}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SERVICE_KEY,
            'Authorization': `Bearer ${SERVICE_KEY}`,
            'Prefer': prefer
          },
          body: JSON.stringify(rows.slice(i, i + BATCH_SIZE))
        });
        if (!res.ok) throw new Error(`棚卸データの${label}に失敗(${i + 1}件目〜): ${await res.text()}`);
      }
    };

    // 登録が失敗したときに在庫が消えないよう、保存が全て成功してから古い行を削除する
    await saveRows(updateRows, '?on_conflict=id', 'resolution=merge-duplicates,return=minimal', '更新');
    await saveRows(insertRows, '', 'return=minimal', '新規登録');

    for (let i = 0; i < toDeleteIds.length; i += BATCH_SIZE) {
      const batch = toDeleteIds.slice(i, i + BATCH_SIZE);
      const res = await fetch(`${SUPABASE_URL}/rest/v1/inventory_items?id=in.(${batch.join(',')})`, {
        method: 'DELETE',
        headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }
      });
      if (!res.ok) throw new Error(`古い棚卸データの削除に失敗: ${await res.text()}`);
    }
    return { success: true, count: rowsMap.size };
}

// --- サーバー起動 ---
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { csv, store_id, mode } = await req.json();
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    let result;
    if (mode === 'realtime') {
      result = await processRealtimeMode(csv, store_id, SUPABASE_URL, SERVICE_KEY);
    } else if (mode === 'purchase_history') {
      result = await processPurchaseHistoryMode(csv, store_id, SUPABASE_URL, SERVICE_KEY);
    } else {
      result = await processInventoryMode(csv, store_id, SUPABASE_URL, SERVICE_KEY);
    }

    return new Response(JSON.stringify(result), { 
      status: 200, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });

  } catch (err: any) {
    console.error(err);
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 500, 　
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});
