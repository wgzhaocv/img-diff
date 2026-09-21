import { ScreenHeader } from "@/components/ScreenHeader";
import { ConvertDestination } from "@/components/ConvertDestination";
import { ConvertOptions } from "@/components/ConvertOptions";
import { ConvertPicker } from "@/components/ConvertPicker";
import { ConvertPreview } from "@/components/ConvertPreview";
import { ConvertProgress } from "@/components/ConvertProgress";
import { ConvertResult } from "@/components/ConvertResult";
import { ConvertRunBar } from "@/components/ConvertRunBar";
import { ConvertSources } from "@/components/ConvertSources";
import { useConvertStore } from "@/lib/stores/convertStore";

// 変換画面（SPEC §5.4）。入力フォルダには一切書かず、出力は「別に選んだフォルダ」か zip。
//
// **この殻は状態をほとんど購読しない。** 進捗は 1 件終わるごとに更新され、実測で最大
// ~580 回/秒に達する。ここでストア全体を読むと画面がまるごと毎フレーム描き直されるので、
// 各部品が**自分に要る値だけ**を zustand の selector で取り、ここは「画像が在るか」しか見ない。
// 進捗はそれ専用の部品（ConvertProgress）に閉じ込めてある。

export function ConvertScreen() {
  const hasSources = useConvertStore((s) => s.sources.length > 0);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      {/* 出力先は「保存先」で、ブラウザ内完結は脚注で言っている。ここは残る 1 つだけ。 */}
      <ScreenHeader title="形式を変換">
        寸法と形式をまとめて変換します。元のフォルダには書き込みません。
      </ScreenHeader>

      {hasSources ? (
        <div className="grid gap-8 md:grid-cols-2">
          {/* 左 = 今の設定で実際に変換した 1 枚と、選んだ画像の一覧。
              狭い画面では設定より先に積む（何に対する設定なのかが先に見えるように）。 */}
          <div className="space-y-6">
            <ConvertPreview />
            <ConvertSources />
          </div>
          {/* 右 = 設定と実行。 */}
          <div className="space-y-6">
            <ConvertOptions />
            <ConvertDestination />
            <ConvertRunBar />
          </div>
        </div>
      ) : (
        <ConvertPicker />
      )}

      <ConvertProgress />
      <ConvertResult />
    </div>
  );
}
