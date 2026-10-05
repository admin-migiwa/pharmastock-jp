import { supabase } from './supabase';
import { ShipmentStatus, ShipmentLookup } from './types';

/**
 * 出荷調整状況（厚労省 医療用医薬品の供給状況）との突合ロジック。
 *
 * 突合の優先順位:
 *  1. YJコード（薬価基準コード12桁）完全一致  … 天六店など、コードがある店舗
 *  2. 正規化名称（name_key）一致           … 南森町店など、コードがない店舗
 *  3. 他店の「名称→YJコード」辞書で逆引き      … 名称が一致しない場合の補完
 *  4. すべて不一致                         … 「情報なし」
 */

// 名称の正規化：NFKC(全角半角統一)→大文字化→空白・記号除去
export const normalizeName = (s: string | null | undefined): string =>
  (s || '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[-‐‑–—―ー−－・･「」『』()（）\[\]［］]/g, '');

export const isValidYjCode = (code: string | null | undefined): boolean =>
  /^[0-9A-Za-z]{12}$/.test((code || '').trim());

const SELECT_COLUMNS =
  'yj_code,name,name_key,maker,status,status_date,reason,outlook,outlook_detail,volume_status,volume_outlook,volume_amount,info_date,is_new,is_adjusting,imported_at';

// 配列を n 件ずつに分割
const chunk = <T,>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

export interface StockKey {
  name: string;
  yakka_code?: string | null;
}

/**
 * 在庫の一覧（検索結果）に対応する出荷状況を取得して突合する。
 * 戻り値は入力と同じ順序の ShipmentLookup 配列。
 * テーブル未作成などで失敗した場合は全件「情報なし」を返す（画面を壊さない）。
 */
export async function lookupShipment(stocks: StockKey[]): Promise<ShipmentLookup[]> {
  const none: ShipmentLookup = { kind: 'none', rows: [] };
  if (stocks.length === 0) return [];

  try {
    const codes = Array.from(
      new Set(stocks.map(s => (s.yakka_code || '').trim()).filter(isValidYjCode))
    );
    const nameKeys = Array.from(new Set(stocks.map(s => normalizeName(s.name)).filter(Boolean)));

    // 辞書補完用：コードなしの在庫は、他店の同名在庫からYJコードを逆引き
    const codeless = stocks.filter(s => !isValidYjCode(s.yakka_code));
    const codelessNames = Array.from(new Set(codeless.map(s => s.name).filter(Boolean)));

    const [byCode, byName, dictRes] = await Promise.all([
      codes.length
        ? supabase.from('shipment_status').select(SELECT_COLUMNS).in('yj_code', codes)
        : Promise.resolve({ data: [] as ShipmentStatus[], error: null }),
      nameKeys.length
        ? supabase.from('shipment_status').select(SELECT_COLUMNS).in('name_key', nameKeys)
        : Promise.resolve({ data: [] as ShipmentStatus[], error: null }),
      codelessNames.length
        ? supabase
            .from('realtime_stocks')
            .select('name,yakka_code')
            .in('name', codelessNames)
            .neq('yakka_code', '')
        : Promise.resolve({ data: [] as { name: string; yakka_code: string }[], error: null }),
    ]);

    if (byCode.error || byName.error) {
      console.warn('出荷状況の取得に失敗しました（shipment_status 未作成の可能性）', byCode.error || byName.error);
      return stocks.map(() => none);
    }

    const codeMap = new Map<string, ShipmentStatus>();
    const nameMap = new Map<string, ShipmentStatus[]>();
    [...((byCode.data as ShipmentStatus[]) || []), ...((byName.data as ShipmentStatus[]) || [])].forEach(r => {
      codeMap.set(r.yj_code, r);
    });
    ((byName.data as ShipmentStatus[]) || []).forEach(r => {
      const list = nameMap.get(r.name_key || '') || [];
      list.push(r);
      nameMap.set(r.name_key || '', list);
    });

    // 辞書：名称 → YJコード（有効な12桁のもののみ）
    const dictMap = new Map<string, string>();
    ((dictRes.data as { name: string; yakka_code: string }[]) || []).forEach(d => {
      if (isValidYjCode(d.yakka_code)) dictMap.set(normalizeName(d.name), d.yakka_code.trim());
    });

    // 辞書で得たYJコードのうち、まだ取得していないものを追加取得
    const missingCodes = Array.from(new Set(Array.from(dictMap.values()))).filter(c => !codeMap.has(c));
    for (const part of chunk(missingCodes, 100)) {
      const { data } = await supabase.from('shipment_status').select(SELECT_COLUMNS).in('yj_code', part);
      ((data as ShipmentStatus[]) || []).forEach(r => codeMap.set(r.yj_code, r));
    }

    return stocks.map(s => {
      const code = (s.yakka_code || '').trim();
      // 1. YJコード
      if (isValidYjCode(code) && codeMap.has(code)) {
        return { kind: 'code', rows: [codeMap.get(code)!] } as ShipmentLookup;
      }
      // 2. 正規化名称
      const key = normalizeName(s.name);
      const named = nameMap.get(key) || [];
      if (named.length === 1) return { kind: 'name', rows: named } as ShipmentLookup;
      if (named.length > 1) return { kind: 'ambiguous', rows: named } as ShipmentLookup;
      // 3. 辞書補完
      const viaDict = dictMap.get(key);
      if (viaDict && codeMap.has(viaDict)) {
        return { kind: 'dict', rows: [codeMap.get(viaDict)!] } as ShipmentLookup;
      }
      // 4. 情報なし
      return none;
    });
  } catch (err) {
    console.warn('出荷状況の突合でエラー', err);
    return stocks.map(() => none);
  }
}

/** 一覧表示用ラベル（調整中でなければ null） */
export const getShipmentBadge = (rows: ShipmentStatus[]): { label: string; level: 'stop' | 'limited' | 'reduced' } | null => {
  // 複数候補の場合は最も深刻なものを返す
  let best: { label: string; level: 'stop' | 'limited' | 'reduced'; rank: number } | null = null;
  for (const r of rows) {
    if (!r.is_adjusting) continue;
    const st = (r.status || '').replace(/^[①-⑩]/, '');
    const vol = (r.volume_status || '').replace(/^[A-Za-zＡ-Ｚプラス]+[．.]/, '');
    let cand: { label: string; level: 'stop' | 'limited' | 'reduced'; rank: number };
    if (st.includes('供給停止') || vol.includes('出荷停止')) {
      cand = { label: st.includes('供給停止') ? '供給停止' : '出荷停止', level: 'stop', rank: 3 };
    } else if (st.includes('限定出荷')) {
      cand = { label: '限定出荷', level: 'limited', rank: 2 };
    } else {
      cand = { label: vol || '出荷調整中', level: 'reduced', rank: 1 };
    }
    if (!best || cand.rank > best.rank) best = cand;
  }
  return best ? { label: best.label, level: best.level } : null;
};
