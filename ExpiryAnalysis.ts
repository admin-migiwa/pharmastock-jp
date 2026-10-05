export interface PurchaseRecord {
  date: string;       // 入庫日
  yakka_code: string; // 薬価コード
  name: string;       // 薬品名
  lot: string;        // ロット番号（製造番号）
  expiry: string;     // 有効年（使用期限）
  quantity: number;   // 数量
}

export interface ExpiryAnalysisResult {
  minExpiry: string;
  isUrgent: boolean;
  breakdown: { lot: string; expiry: string; quantity: number }[];
}

/**
 * 店舗ごとのCSV/TXT項目名の違いをマッピングして統一形式に変換
 */
export const mapStoreData = (rawData: any, type: 'A' | 'B'): PurchaseRecord => {
  if (type === 'A') {
    return {
      date: rawData['日付'],
      yakka_code: rawData['YCODE'] || '',
      name: rawData['薬品名'],
      lot: rawData['ﾛｯﾄNo'],
      expiry: rawData['有効年'],
      quantity: Number(rawData['入庫数'])
    };
  } else {
    return {
      date: rawData['入庫日'],
      yakka_code: rawData['YCODE'] || '',
      name: rawData['商品名'],
      lot: rawData['製造番号'],
      expiry: rawData['使用期限'],
      quantity: Number(rawData['数量'])
    };
  }
};

/**
 * 現在庫数と入庫履歴から、期限の内訳を推測する
 */
export const calculateExpiryBreakdown = (
  currentStockQty: number,
  history: PurchaseRecord[]
): ExpiryAnalysisResult => {
  // 入庫日の新しい順にソート
  const sortedHistory = [...history].sort((a, b) => 
    new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  let remaining = currentStockQty;
  const breakdown: { lot: string; expiry: string; quantity: number }[] = [];
  let minExpiry = "";

  for (const record of sortedHistory) {
    if (remaining <= 0) break;

    const taken = Math.min(remaining, record.quantity);
    breakdown.push({
      lot: record.lot || '不明',
      expiry: record.expiry === "9999-12-31" ? "不明" : record.expiry,
      quantity: taken
    });

    // 9999-12-31（不明扱い）を除外して、最も近い期限を特定
    if (record.expiry && record.expiry !== "9999-12-31") {
      if (!minExpiry || record.expiry < minExpiry) {
        minExpiry = record.expiry;
      }
    }

    remaining -= taken;
  }

  // 履歴が足りない分を補完
  if (remaining > 0) {
    breakdown.push({ lot: '過去在庫分', expiry: '不明', quantity: remaining });
  }

  return {
    minExpiry: minExpiry || "不明",
    isUrgent: checkIsUrgent(minExpiry),
    breakdown
  };
};

const checkIsUrgent = (expiry: string): boolean => {
  if (!expiry || expiry === "不明" || expiry === "9999-12-31") return false;
  
  const expiryDate = new Date(expiry);
  const today = new Date();
  
  // 例：6ヶ月以内を「切迫」と判定する場合
  const sixMonthsLater = new Date();
  sixMonthsLater.setMonth(today.getMonth() + 6);
  
  return expiryDate <= sixMonthsLater;
};
