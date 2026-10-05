import React, { useState } from 'react';
import { 
  BookOpen, 
  Settings, 
  RefreshCw, 
  Package, 
  AlertCircle, 
  CheckCircle2,
  Info,
  ChevronDown,
  Globe
} from 'lucide-react';

const Manual: React.FC = () => {
  // 開閉状態を管理（インデックスを保持）
  const [openItems, setOpenItems] = useState<string[]>([]);

  const toggleItem = (id: string) => {
    setOpenItems(prev => 
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

const sections = [
    {
      id: "sec-0",
      title: "〇 概説：システムの目的",
      icon: <Info className="text-blue-500" />,
      content: "本システムは、グループ内における「在庫の可視化」と「不動在庫の解消」を目的とした、薬剤師のための意思決定支援ツールです。",
      details: [
        "在庫照会：全店舗の最新在庫・期限・入庫ロットを横断検索し、分譲の判断を高速化します。",
        "不動在庫の解消：各店で眠っているデッドストックを抽出し、グループ内で効率的に循環させます。"
      ]
    },
    {
      id: "sec-1",
      title: "1. 導入・初期設定",
      icon: <Settings className="text-slate-500" />,
      items: [
        {
          id: "1-1",
          subTitle: "自店選択（店舗コンテキストの確立）",
          desc: "ログイン後、まず「今、どの店舗の薬剤師として操作するか」を決定します。",
          fullDetails: {
            step: "起動時に表示されるオーバーレイから、管理対象の店舗を選択してください。",
            rule: "自店として選択された店舗は、在庫照会時に最上位に青色で強調されます。また、CSVのインポート先もこの選択された店舗に固定されます。",
            point: "注意：別の店舗のデータを更新したい場合は、必ず右上のセレクトボックスで店舗を切り替えてからインポートを行ってください。"
          }
        }
      ]
    },
    {
      id: "sec-search",
      title: "2. 在庫照会（日次・疑義照会・分譲対応）",
      icon: <Globe className="text-blue-500" />,
      items: [
        {
          id: "2-1",
          subTitle: "在庫照会 (RealtimeSearch)",
          desc: "グループ全店のリアルタイム在庫、使用期限、ロット別内訳を検索します。",
          fullDetails: {
            step: [
              "検索窓に薬品名を入力します（ひらがな、カタカナ、薬価コードに対応）。",
              "「自店舗」の在庫が最上位に強調され、その下に他店舗の在庫が並びます。",
              "行をクリックすると展開される「ロット別内訳」を確認し、使用期限を正確に把握します。"
            ],
            point: "現場での活用：急な処方変更や、自店欠品時の分譲依頼先を検討する際に、電話をかける前にまずここで期限と数量を確認してください。"
          }
        }
      ]
    },
    {
      id: "sec-update",
      title: "3. 在庫更新（月次メンテナンスフロー）",
      icon: <RefreshCw className="text-green-500" />,
      items: [
        {
          id: "3-1",
          subTitle: "STEP1：入庫履歴同期 (ExpiryImport)",
          desc: "レセコンから「入庫履歴（NSIPS等）」を取り込み、薬品ごとのロット・期限マスターを構築します。",
          fullDetails: {
            step: "レセコンから出力した「入庫履歴ファイル」をドラッグ＆ドロップし、[同期を実行] をクリックします。",
            rule: "同一の「店舗・薬品・納品日・ロット」は自動的にUPSERT（存在すれば更新、なければ挿入）されます。重複の心配はありません。",
            important: "【重要】この段階では、在庫一覧側の期限表示はまだ変わりません。期限の「辞書」を最新にしている状態です。"
          }
        },
        {
          id: "3-2",
          subTitle: "STEP2：現在庫同期 (RealtimeStockImport)",
          desc: "レセコンから「現在庫CSV」を取り込み、在庫数と期限を紐付けます。",
          fullDetails: {
            step: [
              "レセコンから出力した「現在庫データ（CSV/TXT）」を選択します。",
              "[同期を実行する] をクリックし、完了メッセージを確認します。"
            ],
            rule: "本機能により、システム上の当該店舗の在庫データは最新状態で完全に「上書き」されます。",
            important: "【必須手順】STEP1の直後に実行することで、最新の入庫履歴（ロット）に基づいた正しい使用期限が、各薬品の在庫数に対して自動的に充填されます。順番を間違えないようにしてください。"
          }
        }
      ]
    },
    {
      id: "sec-tanoroshi",
      title: "4. 棚卸業務（不動在庫整理・店舗間移動）",
      icon: <Package className="text-orange-500" />,
      items: [
        {
          id: "4-1",
          subTitle: "ダッシュボード確認 (Dashboard)",
          desc: "在庫金額や不動在庫の割合、期限切れリスクを視覚的に把握します。",
          fullDetails: {
            action: "「設定不整合（オレンジ色のアラート）」がある薬品は、同一薬品内で『不動在庫』の設定が立っている行と立っていない行が混在しています。データの正確性を保つため、クリックして設定を統一してください。"
          }
        },
        {
          id: "4-2",
          subTitle: "自店在庫仕分け (Inventory)",
          desc: "自店の在庫リストに対し、「不動在庫」や「キープ」の意思表示を行います。",
          fullDetails: {
            step: [
              "「不動」チェック：半年以上動いていない、または今後使用予定がない薬品にチェックを入れます。これにより他店からの引受対象となります。",
              "「キープ」チェック：この店舗で在庫しておきたい薬品にチェックを入れます。他店に引き受けられることはありません。",
              "「不動」と「キープ」を両方チェックすると『キープ・交換希望』の状態になります。これは『在庫はこの店で持っておきたいが、期限が近いので他店の新しいロットと交換できるなら交換したい』という意思表示です。"
            ],
            point: "ポイント：デッドストック化しそうで、かつこの店舗で使う見込みがない薬品には「不動」のみを、期限は近いが引き続きこの店舗で扱いたい薬品には「不動」＋「キープ」を設定してください。ただし「キープ」を付けても在庫は自動では守られません。期限切れのリスクを避けるため、マッチする引受先があれば『キープ・交換希望』品も通常の不動在庫と同様に実際に出庫されます（詳細は次項）。"
          }
        },
        {
          id: "4-3",
          subTitle: "他店在庫の引き受け (Adoption)",
          desc: "他店が「不動」とした在庫を自店でレスキュー（引き受け）するための精査です。",
          fullDetails: {
            step: [
              "【引受検討タブ】：他店の不動在庫が一覧表示されます。自店で使えるものがあれば、数量を入力して引き受けを表明してください。",
              "【確定リストタブ】：他店から自店へ届く予定の薬品、または自店から他店へ発送する薬品の最終リストです。"
            ],
            logic: "「第一候補バッジ」：自店で採用・在庫実績がある薬品にはこのバッジが付きます。優先的に割り当てられるべき項目です。",
            important: "【重要】確定リストを確認し、実際の現品移動（分譲処理）を各店舗間で実施してください。「キープ・交換希望」（不動＋キープ両方ON）に設定されている品目も、マッチする引受先があれば通常の不動在庫と同様に出庫対象になります。次項の「最終決定」画面の「交換希望」タブで、キープ希望だった品目がどう処理されたか（出庫先／不動処理）を確認できます。"
          }
        },
        {
          id: "4-3-5",
          subTitle: "最終決定・指示書印刷 (FinalDetermination)",
          desc: "引受検討の結果をもとに、実際の出庫・入庫・不動在庫を確定し、店舗ごとの指示書を印刷します。「確定リスト」タブから開きます。",
          fullDetails: {
            step: [
              "「出庫」タブ：自店が手放す（発送する）薬品の一覧です。「キープ」品でもマッチする引受先があればここに含まれます。",
              "「入庫」タブ：他店から届く予定の薬品の一覧です。",
              "「不動」タブ：引受手が見つからず、廃棄等の検討が必要な薬品です。「キープ」品でもマッチしなければここに含まれます。",
              "「交換希望」タブ：『キープ・交換希望』を設定していた薬品だけを抜き出して確認できる一覧です。出庫先が決まったものは「◯◯店へ出庫」、マッチせず不動処理になったものは「不動処理」と表示されます。"
            ],
            important: "【重要】欠品より期限切れの方が避けるべきリスクという考え方から、『キープ・交換希望』品も出庫・不動の集計にそのまま含まれます（在庫は実際に動きます）。「交換希望」タブはあくまで『元はキープ希望だった品目』を後から確認するための目印であり、出庫・不動リストと重複して表示されます。新しいロットとの交換が必要な場合は、出庫後に候補店舗と個別に調整してください。",
            point: "画面右上の「印刷」ボタンから、店舗ごとの内訳を指示書として印刷できます（全店舗を対象にした一括印刷モードもあります）。"
          }
        },
        {
          id: "4-5",
          subTitle: "棚卸データインポート (Import)",
          desc: "半年に一度の棚卸結果を反映し、基準となる在庫明細を更新します。",
          fullDetails: {
            step: "一斉棚卸で作成された「22項目在庫明細」等のCSVファイルをインポートします。",
            rule: "この操作により、古い在庫データが一掃され、新しい期としての管理が始まります。"
          }
        }
      ]
    },
    {
      id: "sec-master",
      title: "5. マスタ管理",
      icon: <Settings className="text-purple-500" />,
      items: [
        {
          id: "5-1",
          subTitle: "店舗マスタ管理 (StoreMaster)",
          desc: "管理対象となる店舗の追加や情報の変更を行います。",
          fullDetails: {
            important: "【最重要：禁止事項】『店舗の削除』を行うと、その店舗に紐づいている過去の入庫履歴、在庫データ、不動在庫・キープ設定等の全情報が物理削除され、復元できません。閉局等の明確な理由がない限り、安易な削除は厳禁です。"
          }
        }
      ]
    }
  ];
  
  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in duration-500 pb-20">
      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 to-slate-800 rounded-[32px] p-8 text-white shadow-2xl relative overflow-hidden">
        <div className="relative z-10">
          <h1 className="text-3xl font-black tracking-tight mb-2">PharmaStock JP</h1>
          <p className="text-slate-400 font-bold">運用手順マニュアル</p>
        </div>
        <BookOpen className="absolute right-[-20px] bottom-[-20px] text-white/5 w-48 h-48" />
      </div>

      <div className="grid gap-6">
        {sections.map((section) => (
          <div key={section.id} className="bg-white rounded-[24px] border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-6 border-b border-slate-50 flex items-center gap-4 bg-slate-50/50">
              {section.icon}
              <h2 className="text-lg font-black text-slate-800">{section.title}</h2>
            </div>

            <div className="p-6 space-y-6">
              {section.content && (
                <div className="bg-blue-50 rounded-2xl p-4 text-blue-900 font-medium text-sm leading-relaxed">
                  {section.content}
                  {section.details && (
                    <ul className="mt-2 space-y-1">
                      {section.details.map((d, i) => (
                        <li key={i} className="flex items-start gap-2 text-blue-700/80 text-xs">
                          <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" />
                          {d}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {section.items && (
                <div className="grid gap-4">
                  {section.items.map((item) => {
                    const isOpen = openItems.includes(item.id);
                    return (
                      <div key={item.id} className={`group border rounded-2xl transition-all duration-300 ${isOpen ? 'border-blue-500 bg-blue-50/30' : 'border-slate-100'}`}>
                        <button 
                          onClick={() => toggleItem(item.id)}
                          className="w-full text-left p-4 flex items-start justify-between gap-4"
                        >
                          <div className="space-y-1">
                            <h3 className={`font-black flex items-center gap-2 ${isOpen ? 'text-blue-700' : 'text-slate-700'}`}>
                              {item.subTitle}
                            </h3>
                            <p className="text-slate-500 text-xs leading-relaxed font-bold">
                              {item.desc}
                            </p>
                          </div>
                          <ChevronDown size={20} className={`text-slate-300 transition-transform duration-300 flex-shrink-0 mt-1 ${isOpen ? 'rotate-180 text-blue-500' : ''}`} />
                        </button>

                        {isOpen && (
                          <div className="px-4 pb-4 animate-in slide-in-from-top-2 duration-300">
                            <div className="pt-2 border-t border-blue-100 space-y-4">
                              {/* 1. 手順 (Step) */}
                              {item.fullDetails.step && (
                                <div>
                                  <div className="text-[10px] font-black text-blue-500 uppercase tracking-widest mb-1">Step / 手順</div>
                                  <div className="text-slate-700 text-xs font-bold leading-relaxed space-y-1">
                                    {Array.isArray(item.fullDetails.step) 
                                      ? item.fullDetails.step.map((s, idx) => <div key={idx} className="flex gap-2"><span>{idx+1}.</span>{s}</div>)
                                      : <div>{item.fullDetails.step}</div>
                                    }
                                  </div>
                                </div>
                              )}

                              {/* 2. 重要事項 (Important) - 追加 */}
                              {item.fullDetails.important && (
                                <div className="bg-red-50 rounded-xl p-3 border border-red-100">
                                  <div className="flex items-center gap-2 text-[10px] font-black text-red-500 uppercase tracking-widest mb-1">
                                    <AlertCircle size={12} />
                                    Important / 重要
                                  </div>
                                  <div className="text-red-900 text-[11px] font-black leading-relaxed">
                                    {item.fullDetails.important}
                                  </div>
                                </div>
                              )}

                              {/* 3. 具体的なアクション (Action) - 追加 */}
                              {item.fullDetails.action && (
                                <div className="bg-emerald-50 rounded-xl p-3 border border-emerald-100">
                                  <div className="flex items-center gap-2 text-[10px] font-black text-emerald-600 uppercase tracking-widest mb-1">
                                    <CheckCircle2 size={12} />
                                    Action / 実施事項
                                  </div>
                                  <div className="text-emerald-900 text-[11px] font-bold leading-relaxed">
                                    {item.fullDetails.action}
                                  </div>
                                </div>
                              )}

                              {/* 4. ルール・ポイント (Note) */}
                              {(item.fullDetails.rule || item.fullDetails.point || item.fullDetails.logic) && (
                                <div className="bg-white/60 rounded-xl p-3 border border-blue-100/50">
                                  <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Note / ルール・詳細</div>
                                  <div className="text-slate-600 text-[11px] font-bold leading-relaxed">
                                    {item.fullDetails.rule || item.fullDetails.point || item.fullDetails.logic}
                                  </div>
                                </div>
                              )}

                              {/* 5. 確認項目 (Check) */}
                              {item.fullDetails.check && (
                                <div>
                                  <div className="text-[10px] font-black text-orange-500 uppercase tracking-widest mb-1">Check / 完了後の確認</div>
                                  <div className="text-slate-700 text-xs font-bold leading-relaxed space-y-2 bg-orange-50/50 p-3 rounded-xl border border-orange-100">
                                    {item.fullDetails.check.map((c, idx) => (
                                      <div key={idx} className="flex gap-2">
                                        <CheckCircle2 size={14} className="text-orange-400 flex-shrink-0 mt-0.5" />
                                        {c}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Footer Alert */}
      <div className="bg-amber-50 border border-amber-100 rounded-2xl p-6 flex gap-4">
        <AlertCircle className="text-amber-500 flex-shrink-0" />
        <div>
          <h4 className="text-amber-900 font-black text-sm mb-1">トラブルシューティング</h4>
          <p className="text-amber-800/80 text-xs font-bold leading-relaxed">
            データが反映されない場合は、CSVの形式（文字コード等）を確認してください。
            また、店舗マスタを削除すると紐づく在庫データもすべて消去されるため、実行には十分注意してください。
          </p>
        </div>
      </div>
      
      <div className="text-center py-8 text-slate-400 font-bold text-[10px] uppercase tracking-[0.2em]">
        End of Document
      </div>
    </div>
  );
};

export default Manual;