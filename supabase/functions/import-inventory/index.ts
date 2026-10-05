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
// 全角の数字・英字を半角に変換（CSVデータに全角混じりのため）
const toHalfWidth = (str: string): string => {
  if (!str) return str;
  return str.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
  );
};
// 末尾の単位と数値をダイレクトにマッチさせる
const parseContentAmount = (name: string): number => {
  if (!name) return 1;
  const normalized = toHalfWidth(name);
  // 単位（g, 錠, 包, 本, 個, 枚, ｷｯﾄ, ml, カプセル 等）の直前にある数値を、末尾から探して抽出
  // ※文字クラスではなく交代(|)で複数文字の単位（ml、ｷｯﾄ、カプセル等）も正しく拾えるようにしている
  const match = normalized.match(/([0-9.]+)\s*(?:g|錠|包|本|個|枚|ｷｯﾄ|キット|ml|カプセル|ｶﾌﾟｾﾙ)[\)）]$/i);
  return match ? parseFloat(match[1]) : 1;
};
// 規格の「100錠入り」「42包入り」から数値を抽出
const parsePackSize = (spec: string): number => {
  if (!spec) return 1;
  const normalized = toHalfWidth(spec);
  const match = normalized.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 1;
};

// 薬価コードなどのクレンジング（スペース除去、文字列化）
const cleanCode = (val: any) => (val || '').toString().replace(/^"|"$/g, '').trim();

// 名称の正規化（空白除去）- 南森町店などの名称マッチング精度向上用
const normalize = (val: string) => (val || '').replace(/[\s　]/g, '');

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
    yCode: getIdx(headers, ['厚生省ｺｰﾄﾞ', '厚生省コード', 'YCODE', 'GS1/JAN', 'JANコード'], 15)
  };

  const rowsMap = new Map<string, any>();
  const targetYakkaCodes = new Set<string>();
    for (let i = headerIdx + 1; i < allLines.length; i++) {
    const cols = splitCsvLine(allLines[i]);
    if (cols.length <= Math.max(...Object.values(idx))) continue;

    const boxQty = toNum(cols[idx.qty]); // CSVの入庫数（箱数や本数)
    const rawName = cols[idx.name]?.replace(/^"|"$/g, '').trim();
    const rawSpec = headers.includes('規格') ? (cols[headers.indexOf('規格')] || '').replace(/^"|"$/g, '').trim() : '';
    if (!rawName || boxQty === 0) continue;

    // --- ここでバラ換算を実行 ---
    const contentAmount = parseContentAmount(rawName); // （）内の5gなど
    const packSize = parsePackSize(rawSpec);           // 100錠入りなど
    const totalUnitQty = boxQty * packSize * contentAmount; // 総バラ数

    const purchaseDate = toDate(cols[idx.date]) || now.split('T')[0];
    const yakkaCode = cleanCode(cols[idx.yCode]);
    const lotNumber = cleanCode(cols[idx.lot]) || 'LOT不明';

    if (yakkaCode) targetYakkaCodes.add(yakkaCode);
    
    // 数量(qty)をキーから外し、同一納品として集約する
    const compositeKey = `${purchaseDate}_${yakkaCode}_${lotNumber}`;

    if (rowsMap.has(compositeKey)) {
      // すでに同じキーがあれば、数量を合算する
      const existing = rowsMap.get(compositeKey);
      existing.quantity += totalUnitQty;
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
        updated_at: now
      });
    }
  }

  const historyRows = Array.from(rowsMap.values());
  if (historyRows.length === 0) throw new Error("有効なデータが見つかりませんでした。");

  // 1. 入庫履歴の保存（バッチ処理 500件ずつ）
  const BATCH_SIZE = 500;
  for (let i = 0; i < historyRows.length; i += BATCH_SIZE) {
    const batch = historyRows.slice(i, i + BATCH_SIZE);
    const historyRes = await fetch(`${SUPABASE_URL}/rest/v1/purchase_history?on_conflict=store_id,purchase_date,yakka_code,lot_number`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify(batch)
    });
    // 失敗を握りつぶさない（これが無いと「更新完了」の誤表示につながる）
    if (!historyRes.ok) throw new Error(`入庫履歴の保存失敗(${i}件目〜): ${await historyRes.text()}`);
  }

// 2. 影響を受ける在庫のみ期限計算を回す（負荷対策：分割取得に修正）
const codesArray = Array.from(targetYakkaCodes).filter(c => c !== '');
if (codesArray.length > 0) {
  const currentRT: any[] = [];
  const QUERY_BATCH_SIZE = 100; // 安全な文字数に収まるよう分割

  for (let i = 0; i < codesArray.length; i += QUERY_BATCH_SIZE) {
    const chunk = codesArray.slice(i, i + QUERY_BATCH_SIZE);
    const queryCodes = chunk.map(c => `"${c}"`).join(',');
    const rtRes = await fetch(`${SUPABASE_URL}/rest/v1/realtime_stocks?store_id=eq.${store_id}&yakka_code=in.("${queryCodes}")`, {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }
    });
    
    if (rtRes.ok) {
      const data = await rtRes.json();
      currentRT.push(...data);
    }
  }

    if (currentRT.length > 0) {
      const updateRows = currentRT.map((stock: any) => {
        // 今インポートしたデータの中から該当するものを探す（簡易計算）
        const matches = historyRows.filter(h => h.yakka_code === stock.yakka_code);
        if (matches.length > 0) {
          const latestMatch = matches.sort((a, b) => b.purchase_date.localeCompare(a.purchase_date))[0];
          return {
            id: stock.id,
            expiry_date: latestMatch.expiry_date || '9999-12-31',
            expiry_updated_at: now,
            updated_at: now
          };
        }
        return null;
      }).filter(Boolean);

      if (updateRows.length > 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/realtime_stocks`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SERVICE_KEY,
            'Authorization': `Bearer ${SERVICE_KEY}`,
            'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify(updateRows)
        });
      }
    }
  }

  return { success: true, count: historyRows.length };
}

/**
 * リアルタイム在庫（レセコンデータ）専用の処理
 */
async function processRealtimeMode(csvText: string, store_id: string, SUPABASE_URL: string, SERVICE_KEY: string) {
  const now = new Date().toISOString();
  // 1. 入庫履歴を「購入日が新しい順」に全件取得
  const historyRes = await fetch(`${SUPABASE_URL}/rest/v1/purchase_history?store_id=eq.${encodeURIComponent(store_id)}&order=purchase_date.desc`, {
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }
  });
  let allHistory: any[] = [];
  if (historyRes.ok) {
    allHistory = await historyRes.json();
  }

  // 検索用Map作成: yakka_codeと、正規化した名称の両方で引けるようにする
  const historyMap = new Map<string, any[]>();
  allHistory.forEach(h => {
    if (h.yakka_code) {
      if (!historyMap.has(h.yakka_code)) historyMap.set(h.yakka_code, []);
      historyMap.get(h.yakka_code)!.push(h);
    }
    const normalizedName = normalize(h.name);
    if (!historyMap.has(normalizedName)) historyMap.set(normalizedName, []);
    historyMap.get(normalizedName)!.push(h);
  });

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

const realtimeRows = allLines.slice(1).map(line => {
  const cols = splitCsvLine(line);
  if (cols.length <= Math.max(...Object.values(idx))) return null;
  
  const stockQty = toNum(cols[idx.stock]);
  const name = cleanCode(cols[idx.name]);
  if (!name || stockQty === 0) return null;
  const yakka = idx.yj !== -1 ? cleanCode(cols[idx.yj]) : '';
  const normalizedName = normalize(name);

  // --- 理論在庫の期限充填ロジック ---
  // Mapから該当する履歴を高速取得
  const matches = (yakka ? historyMap.get(yakka) : null) || historyMap.get(normalizedName) || [];  
  let mainExpiry = '9999-12-31';
  let details: any[] = []; // 内訳データ用

 if (matches.length > 0) {
      let remaining = stockQty;
      const tempDetails = [];
      // 納品日が新しい順に在庫数を埋めていく
      for (const m of matches) {
        if (remaining <= 0) break;
    const historyQty = m.quantity || 0;
    const take = Math.min(remaining, historyQty);
    
    if (take > 0) {
      tempDetails.push({
          lot: m.lot_number || '不明',
          expiry: m.expiry_date || '9999-12-31',
          qty: take,
          purchase_date: m.purchase_date
        });
        remaining -= take;
      }
    }

    // 納品履歴をすべて足しても在庫数に満たない場合、不足分を「不明」として追加
    if (remaining > 0) {
      tempDetails.push({
        lot: '不明（履歴不足）',
        expiry: '9999-12-31',
        qty: remaining,
        purchase_date: null
      });
    }

    details = tempDetails;

    // 代表期限：現在庫として算出したバッチの中で「最も期限が近いもの」を選択
    // これにより、古い在庫が混じっている場合に正しくリスクを表示できる
    mainExpiry = details.reduce((min, d) => {
      if (!d.expiry || d.expiry === '未設定') return min;
      return d.expiry < min ? d.expiry : min;
    }, '9999-12-31');
  }

  return {
    store_id,
    yakka_code: yakka,
    name,
    spec: idx.spec !== -1 ? cleanCode(cols[idx.spec]) : '',
    stock_qty: stockQty,
    unit: idx.unit !== -1 ? cleanCode(cols[idx.unit]) : '',
    expiry_date: mainExpiry,
    expiry_details: details,
    stock_updated_at: now, 
    updated_at: now       
  };
}).filter(Boolean);

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
    const existingRes = await fetch(fetchUrl, { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } });
    const existing = existingRes.ok ? await existingRes.json() : [];
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

    const newRows = Array.from(rowsMap.values());
    const toDeleteIds: string[] = [];
    for (const r of existing) {
      const key = generateKey(r.yakka_code, r.lot_number, r.expiry_date);
      if (!newKeys.has(key)) toDeleteIds.push(r.id);
    }

    if (toDeleteIds.length > 0) {
      const BATCH_SIZE = 100;
      for (let i = 0; i < toDeleteIds.length; i += BATCH_SIZE) {
        const batch = toDeleteIds.slice(i, i + BATCH_SIZE);
        await fetch(`${SUPABASE_URL}/rest/v1/inventory_items?id=in.(${batch.join(',')})`, { method: 'DELETE', headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } });
      }
    }

    if (newRows.length > 0) {
      const UPSERT_BATCH_SIZE = 100;
      for (let i = 0; i < newRows.length; i += UPSERT_BATCH_SIZE) {
        const batchRows = newRows.slice(i, i + UPSERT_BATCH_SIZE);
        await fetch(`${SUPABASE_URL}/rest/v1/inventory_items`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SERVICE_KEY,
            'Authorization': `Bearer ${SERVICE_KEY}`,
             'Prefer': 'resolution=merge-duplicates, ON_CONFLICT=inventory_items_unique_key'
          },
          body: JSON.stringify(batchRows)
        });
      }
    }
    return { success: true, count: newRows.length };
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
