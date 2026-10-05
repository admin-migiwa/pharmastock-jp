import React, { useState, useRef } from 'react';
import { FileText, RefreshCw, Upload, CheckCircle, AlertCircle, Info, Building2, FileWarning, AlertTriangle, X } from 'lucide-react';
import { supabase } from '../supabase';
import { Store } from '../types';

interface ExpiryImportProps {
  storeId: string;
  stores: Store[];
}

export const ExpiryImport: React.FC<ExpiryImportProps> = ({ storeId, stores }) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [message, setMessage] = useState<string>('');
  const [messageType, setMessageType] = useState<'success' | 'error' | 'info' | ''>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false);

  const currentStoreName = stores.find(s => s.id === storeId)?.name || '未設定の店舗';

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const fileName = file.name.toLowerCase();
    const isTxt = fileName.endsWith('.txt');
    const isCsv = fileName.endsWith('.csv');

    if (!isTxt && !isCsv) {
      setMessage('.txt または .csv ファイルを選択してください。');
      setMessageType('error');
      return;
    }

    setSelectedFile(file);
    setMessage(`${file.name} を認識しました。入庫履歴として同期します。`);
    setMessageType('info');
  };

    // 同期ボタンが押されたら、まずはポップアップを表示して処理を止める
    const handleImportClick = () => {
      if (!selectedFile || !storeId) return;
      setShowConfirmModal(true); 
    };

    // ポップアップ内で「間違いありません」が押されたら通信を実行する
    const handleFinalConfirm = async () => {
      setShowConfirmModal(false); // モーダルを閉じる
      setIsLoading(true);
      setMessage('');

    try {
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('ファイル読み込み失敗'));
        reader.readAsText(selectedFile, 'Shift_JIS');
      });

      // Edge Function に送信
      const response = await supabase.functions.invoke('import-inventory', {
        body: {
          csv: text,
          store_id: storeId,
          mode: 'purchase_history', // 入庫履歴モードを明示
          file_type: selectedFile.name.toLowerCase().endsWith('.csv') ? 'csv' : 'txt'
        }
      });

      if ((response as any).error) throw new Error((response as any).error.message);

      setMessage(`✓ ${currentStoreName} の入庫履歴を更新しました。`);
      setMessageType('success');
      setSelectedFile(null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '同期に失敗しました');
      setMessageType('error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between border-b pb-6 border-slate-200">
        <div>
          <h1 className="text-2xl font-black text-slate-900 flex items-center gap-3">
            <Upload className={`w-8 h-8 text-blue-600 ${isLoading ? 'animate-bounce' : ''}`} />
            入庫履歴（期限データ）同期
          </h1>
          <p className="text-slate-500 text-sm font-bold mt-1 uppercase">Purchase History Sync</p>
        </div>
        <div className="bg-slate-900 text-white px-6 py-3 rounded-2xl flex items-center gap-3 shadow-lg">
          <Building2 className="w-5 h-5 text-blue-400" />
          <span className="text-sm font-black">{currentStoreName}</span>
        </div>
      </div>

      {/* --- 運用のための重要アナウンス --- */}
      <div className="bg-amber-50 border-2 border-amber-200 p-5 rounded-[24px] flex items-start gap-4 shadow-sm">
        <div className="bg-amber-100 p-2 rounded-xl text-amber-600">
          <FileWarning size={24} />
        </div>
        <div className="space-y-1">
          <h4 className="text-sm font-black text-amber-900">入庫履歴の更新後は「現在庫データ」の同期が必要です</h4>
          <p className="text-xs font-bold text-amber-700 leading-relaxed">
            本システムは「最新の入庫履歴」と「現在の在庫数」を突き合わせて期限を計算しています。
            <br />
            入庫履歴（NSIPS等）を同期した後は、必ず<span className="underline decoration-2 underline-offset-2 decoration-amber-400">「STEP2現在庫同期」</span>も続けて実施してください。
          </p>
        </div>
      </div>
      {/* ------------------------------------- */}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 space-y-4">
          <div className={`relative border-4 border-dashed rounded-[32px] p-10 transition-all flex flex-col items-center justify-center text-center ${
              selectedFile ? 'bg-blue-50 border-blue-400' : 'bg-white border-slate-200 hover:border-blue-300'
            }`}>
            <input ref={fileInputRef} type="file" accept=".txt,.csv" onChange={handleFileChange} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
            <div className={`p-5 rounded-3xl mb-4 ${selectedFile ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
              <FileText size={40} />
            </div>
            <h3 className="text-lg font-black text-slate-800">{selectedFile ? selectedFile.name : '入庫履歴ファイルをドロップ'}</h3>
          </div>

          {message && (
            <div className={`p-4 rounded-2xl flex items-center gap-3 border-2 ${
              messageType === 'success' ? 'bg-green-50 border-green-200 text-green-700' :
              messageType === 'error' ? 'bg-red-50 border-red-200 text-red-700' : 'bg-blue-50 border-blue-200 text-blue-700'
            }`}>
              {messageType === 'success' ? <CheckCircle size={20} /> : messageType === 'error' ? <AlertCircle size={20} /> : <Info size={20} />}
              <span className="text-sm font-bold">{message}</span>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <button onClick={handleImportClick} disabled={!selectedFile || isLoading} className="w-full h-32 rounded-[32px] bg-blue-600 text-white font-black text-lg shadow-xl shadow-blue-200 disabled:bg-slate-100 disabled:text-slate-400 flex flex-col items-center justify-center gap-2">
            {isLoading ? <RefreshCw className="animate-spin" size={32} /> : <CheckCircle size={32} />}
            <span className="block mt-2">同期を実行</span>
          </button>
        </div>
        {showConfirmModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
            <div className="bg-white rounded-[32px] p-8 max-w-md w-full shadow-2xl border border-slate-100 mx-4 relative space-y-6">
 <button onClick={() => setShowConfirmModal(false)} className="absolute top-6 right-6 text-slate-400 hover:text-slate-600 transition-colors">
                <X size={24} />
              </button>

              <div className="flex items-center gap-3 text-amber-500 border-b pb-4 border-slate-100">
                <AlertTriangle size={32} className="shrink-0" />
                <h3 className="text-xl font-black text-slate-900">店舗選択の最終確認</h3>
              </div>

              <div className="space-y-4">
                <p className="text-sm font-bold text-slate-600 leading-relaxed">
                  現在、選択されている店舗は以下の通りです。
                  <br />
                  他店舗のデータと混ざっていないか必ずご確認ください。
                </p>
                
                <div className="bg-slate-900 text-white p-5 rounded-2xl flex flex-col items-center justify-center gap-1 shadow-inner">
                  <span className="text-xs text-blue-400 font-bold uppercase tracking-wider">同期対象店舗</span>
                  <span className="text-xl font-black tracking-tight">{currentStoreName}</span>
                </div>

                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-[11px] text-slate-500 font-bold">
                  ※入庫履歴はデータベースに蓄積され、過去の在庫配置や期限計算のロジックに影響を与えます。
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 pt-2">
                <button onClick={() => setShowConfirmModal(false)} className="py-4 rounded-2xl border-2 border-slate-200 text-slate-500 font-black hover:bg-slate-50 transition-colors text-sm">
                  キャンセル
                </button>
                <button onClick={handleFinalConfirm} className="py-4 rounded-2xl bg-blue-600 text-white font-black hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all text-sm">
                  間違いありません
                </button>
              </div>

            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ExpiryImport;

