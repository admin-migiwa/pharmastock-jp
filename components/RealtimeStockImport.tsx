import React, { useState, useRef } from 'react';
import { FileText, RefreshCw, Upload, CheckCircle, AlertCircle, Info, Building2, FileWarning } from 'lucide-react';
import { supabase } from '../supabase';
import { Store } from '../types';

interface RealtimeStockImportProps {
  storeId: string;
  stores: Store[];
}

const RealtimeStockImport: React.FC<RealtimeStockImportProps> = ({ storeId, stores }) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [message, setMessage] = useState<string>('');
  const [messageType, setMessageType] = useState<'success' | 'error' | 'info' | ''>('');
  const [syncCount, setSyncCount] = useState<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentStoreName = stores.find(s => s.id === storeId)?.name || '未設定の店舗';

  const resetMessage = () => {
    setMessage('');
    setMessageType('');
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    resetMessage();
    const file = event.target.files?.[0];
    if (!file) {
      setSelectedFile(null);
      return;
    }

      // .txt だけでなく .csv も許可
      const fileName = file.name.toLowerCase();
      const isTxt = fileName.endsWith('.txt');
      const isCsv = fileName.endsWith('.csv');

    // 拡張子チェックの厳格化
    if (!isTxt && !isCsv) {
      setSelectedFile(null);
      setMessage('.txt または .csv ファイルを選択してください。');
      setMessageType('error');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setSelectedFile(file);
    setMessage(`${file.name} が選択されました。同期を開始できます。`);
    setMessageType('info');
  };

  const handleImport = async () => {
    if (!selectedFile || !storeId) return;

    resetMessage();
    setIsLoading(true);

    try {
      // ファイル読み込み (Shift-JIS)
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('ファイル読み込み失敗'));
        reader.readAsText(selectedFile, 'Shift_JIS');
      });

      // Edge Function 呼び出し (mode: 'realtime' を明示)
      const response = await supabase.functions.invoke('import-inventory', {
        body: {
          csv: text, // パラメータ名は共通だが中身はTXT
          store_id: storeId,
          mode: 'realtime',
          // ファイル形式を明示的に送ることで Edge Function 側の判定精度を上げる
          file_type: selectedFile.name.toLowerCase().endsWith('.csv') ? 'csv' : 'txt'
        }
      });

      if ((response as any).error) {
        throw new Error((response as any).error.message || '同期エラーが発生しました');
      }

      const data = (response as any).data;
      const count = data?.count || data?.imported_count || 0;
      
      setSyncCount(count);
      setMessage(`✓ ${currentStoreName} の在庫データを ${count} 件更新しました`);
      setMessageType('success');
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';

    } catch (err) {
      setMessage(err instanceof Error ? err.message : '同期に失敗しました');
      setMessageType('error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto p-6 space-y-6 animate-in fade-in">
      {/* タイトルエリア */}
      <div className="flex items-center justify-between border-b pb-6 border-slate-200">
        <div>
          <h1 className="text-2xl font-black text-slate-900 flex items-center gap-3">
            <RefreshCw className={`w-8 h-8 text-blue-600 ${isLoading ? 'animate-spin' : ''}`} />
            現在庫データ同期
          </h1>
          <p className="text-slate-500 text-sm font-bold mt-1 uppercase tracking-wider">
            Realtime Inventory Synchronization
          </p>
        </div>
        <div className="bg-slate-900 text-white px-6 py-3 rounded-2xl flex items-center gap-3 shadow-lg">
          <Building2 className="w-5 h-5 text-blue-400" />
          <div>
            <p className="text-[10px] font-black text-slate-400 leading-none mb-1 uppercase">Target Store</p>
            <p className="text-sm font-black leading-none">{currentStoreName}</p>
          </div>
        </div>
      </div>

      {/* メイン同期エリア */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* 左側：ファイル選択エリア */}
        <div className="md:col-span-2 space-y-4">
          <div 
            className={`relative border-4 border-dashed rounded-[32px] p-10 transition-all flex flex-col items-center justify-center text-center ${
              selectedFile ? 'bg-blue-50 border-blue-400' : 'bg-white border-slate-200 hover:border-blue-300'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.csv"
              onChange={handleFileChange}
              disabled={isLoading}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
            />
            
            <div className={`p-5 rounded-3xl mb-4 ${selectedFile ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
              <FileText size={40} />
            </div>
            
            <h3 className="text-lg font-black text-slate-800">
              {selectedFile ? selectedFile.name : '在庫ファイルをドロップ'}
            </h3>
            <p className="text-xs text-slate-400 font-bold mt-2">
              Shift-JIS形式 / .txt または .csv に対応
            </p>
          </div>

          {/* メッセージ表示 */}
          {message && (
            <div className={`p-4 rounded-2xl flex items-center gap-3 border-2 ${
              messageType === 'success' ? 'bg-green-50 border-green-200 text-green-700' :
              messageType === 'error' ? 'bg-red-50 border-red-200 text-red-700' :
              'bg-blue-50 border-blue-200 text-blue-700'
            }`}>
              {messageType === 'success' ? <CheckCircle size={20} /> : 
               messageType === 'error' ? <AlertCircle size={20} /> : <Info size={20} />}
              <span className="text-sm font-bold">{message}</span>
            </div>
          )}
        </div>

        {/* 右側：実行・ステータスエリア */}
        <div className="space-y-4">
          <button
            onClick={handleImport}
            disabled={!selectedFile || isLoading}
            className={`w-full h-32 rounded-[32px] flex flex-col items-center justify-center gap-2 transition-all shadow-xl active:scale-95 ${
              !selectedFile || isLoading 
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed' 
                : 'bg-blue-600 text-white hover:bg-blue-700 shadow-blue-200'
            }`}
          >
            {isLoading ? <RefreshCw className="animate-spin" size={32} /> : <Upload size={32} />}
            <span className="font-black text-lg">同期を実行する</span>
          </button>

          <div className="bg-amber-50 border border-amber-200 p-5 rounded-[24px]">
            <div className="flex items-center gap-2 text-amber-700 mb-2 font-black text-xs">
              <FileWarning size={16} />
              <span>注意点</span>
            </div>
            <ul className="text-[11px] text-amber-800 font-bold space-y-2 leading-relaxed">
              <li>• レセコンの「現在庫一覧」または「在庫データCSV」をご利用ください</li>
              <li>• この操作は「引受情報」には影響しません。純粋な在庫数のみ更新されます。</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RealtimeStockImport;