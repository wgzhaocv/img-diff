import { useEffect } from "react";
import { ScreenHeader } from "@/components/ScreenHeader";
import { ConvertOptions } from "@/components/ConvertOptions";
import { ConvertPicker } from "@/components/ConvertPicker";
import { ConvertPreview } from "@/components/ConvertPreview";
import { useConvertStore } from "@/lib/stores/convertStore";

// 変換画面（SPEC §5.4）。**扱うのは 1 枚だけ**で、この画面に「実行」は無い ——
// プレビューが成果物そのものなので、`保存` を押すとブラウザの既定のダウンロード先へ落ちる。
//
// **この殻は状態をほとんど購読しない。** 各部品が**自分に要る値だけ**を zustand の
// selector で取り、ここは「画像が在るか」しか見ない。

export function ConvertScreen() {
  const hasSource = useConvertStore((s) => s.source != null);
  const warmEngine = useConvertStore((s) => s.warmEngine);

  // **画面を開いた時点で wasm-vips を起こす。**（約 11.9MB / 実測 2.5 秒）
  // `hasSource` で条件を付けない —— 画像を選んでいる間にダウンロードを重ねるのが目的。
  useEffect(() => {
    void warmEngine();
  }, [warmEngine]);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      {/* ブラウザ内完結は脚注で言っている。ここは残る 1 つだけ。 */}
      <ScreenHeader title="形式を変換">
        画像 1 枚の寸法と形式を変えて、そのまま保存します。
      </ScreenHeader>

      {hasSource ? (
        <div className="grid gap-8 md:grid-cols-2">
          {/* 左 = 今の設定で実際に変換した結果と、その保存。
              狭い画面では設定より先に積む（何に対する設定なのかが先に見えるように）。 */}
          <ConvertPreview />
          {/* 右 = 設定。 */}
          <ConvertOptions />
        </div>
      ) : (
        <ConvertPicker />
      )}
    </div>
  );
}
