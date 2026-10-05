
import React, { useState } from 'react';
import { Store, InventoryItem } from '../types';
import { Plus, Trash2, Edit2, Check, X, Store as StoreIcon, AlertTriangle } from 'lucide-react';

interface Props {
  stores: Store[];
  setStores: React.Dispatch<React.SetStateAction<Store[]>>;
  inventory: InventoryItem[];
  setInventory: React.Dispatch<React.SetStateAction<InventoryItem[]>>;
  currentStoreId: string;
  setCurrentStoreId: React.Dispatch<React.SetStateAction<string>>;
}

const StoreMaster: React.FC<Props> = ({ 
  stores, 
  setStores, 
  inventory, 
  setInventory, 
  currentStoreId, 
  setCurrentStoreId 
}) => {
  const [newStoreName, setNewStoreName] = useState('');
  const [editingStoreId, setEditingStoreId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const addStore = () => {
    if (!newStoreName.trim()) return;
    const newStore = { id: crypto.randomUUID(), name: newStoreName.trim() };
    setStores([...stores, newStore]);
    setNewStoreName('');
  };

  const deleteStore = (id: string) => {
    if (stores.length <= 1) {
      alert('システム稼働のため、少なくとも1つの店舗が必要です。');
      return;
    }

    const storeToDelete = stores.find(s => s.id === id);
    const relatedInventoryCount = inventory.filter(i => i.store_id === id).length;

    const message = relatedInventoryCount > 0 
      ? `【警告】店舗「${storeToDelete?.name}」を削除しますか？\nこの店舗に登録されている ${relatedInventoryCount} 件の在庫データもすべて永久に削除されます。`
      : `店舗「${storeToDelete?.name}」を削除してもよろしいですか？`;

    if (window.confirm(message)) {
      // 1. 店舗の削除
      const updatedStores = stores.filter(s => s.id !== id);
      setStores(updatedStores);

      // 2. 関連在庫の連動削除 (ON DELETE CASCADE相当)
      setInventory(prev => prev.filter(i => i.store_id !== id));

      // 3. 現在選択中の店舗が削除対象だった場合の切り替え
      if (currentStoreId === id) {
        setCurrentStoreId(updatedStores[0].id);
      }
    }
  };

  const startEditing = (store: Store) => {
    setEditingStoreId(store.id);
    setEditingName(store.name);
  };

  const saveEdit = () => {
    if (!editingName.trim() || !editingStoreId) return;
    setStores(prev => prev.map(s => s.id === editingStoreId ? { ...s, name: editingName.trim() } : s));
    setEditingStoreId(null);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div className="bg-white p-8 rounded-3xl shadow-sm border space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold text-slate-800 flex items-center">
            <StoreIcon className="mr-2 text-blue-600" />
            店舗マスタ管理
          </h2>
          <span className="text-xs text-slate-400 font-medium">
            全 {stores.length} 店舗
          </span>
        </div>

        {/* Add Store */}
        <div className="flex gap-3">
          <input
            type="text"
            placeholder="新規店舗名を入力..."
            value={newStoreName}
            onChange={(e) => setNewStoreName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addStore()}
            className="flex-1 px-4 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
          />
          <button 
            onClick={addStore}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-xl font-bold flex items-center transition-all shadow-md active:scale-95"
          >
            <Plus size={18} className="mr-2" />
            追加
          </button>
        </div>

        {/* Store List */}
        <div className="space-y-3">
          {stores.map(store => {
            const count = inventory.filter(i => i.store_id === store.id).length;
            return (
              <div 
                key={store.id} 
                className={`p-4 rounded-2xl border transition-all flex items-center justify-between ${
                  currentStoreId === store.id ? 'bg-blue-50 border-blue-200' : 'bg-slate-50 border-slate-100'
                }`}
              >
                {editingStoreId === store.id ? (
                  <div className="flex-1 flex gap-2 mr-4">
                    <input
                      type="text"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      className="flex-1 px-3 py-1 border border-blue-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                      autoFocus
                    />
                    <button onClick={saveEdit} className="p-2 text-green-600 hover:bg-green-100 rounded-lg">
                      <Check size={18} />
                    </button>
                    <button onClick={() => setEditingStoreId(null)} className="p-2 text-slate-400 hover:bg-slate-200 rounded-lg">
                      <X size={18} />
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center">
                      <div className="flex flex-col">
                        <span className="font-bold text-slate-800">{store.name}</span>
                        <span className="text-[10px] text-slate-400 flex items-center mt-0.5">
                          在庫データ: {count} 品目
                        </span>
                      </div>
                      {currentStoreId === store.id && (
                        <span className="ml-3 text-[10px] bg-blue-600 text-white px-2 py-0.5 rounded-full font-bold uppercase tracking-widest">
                          選択中
                        </span>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <button 
                        onClick={() => startEditing(store)}
                        className="p-2 text-slate-400 hover:text-blue-600 hover:bg-white rounded-xl transition-all"
                        title="名前を編集"
                      >
                        <Edit2 size={18} />
                      </button>
                      <button 
                        onClick={() => deleteStore(store.id)}
                        className="p-2 text-slate-400 hover:text-red-600 hover:bg-white rounded-xl transition-all"
                        title="店舗を削除"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="bg-amber-50 border border-amber-100 p-4 rounded-xl flex items-start space-x-3">
          <AlertTriangle className="text-amber-500 flex-shrink-0" size={18} />
          <p className="text-xs text-amber-700 leading-relaxed">
            店舗を削除すると、その店舗に関連付けられたインベントリ（在庫薬品）もすべて削除されます。この操作は取り消せませんのでご注意ください。
          </p>
        </div>
      </div>
    </div>
  );
};

export default StoreMaster;
