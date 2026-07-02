import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ScreenHeader } from "@/components/ScreenHeader";
import { ImageSlot } from "@/components/ImageSlot";
import { CompareView } from "@/components/CompareView";
import { compareFiles, type CompareOutcome } from "@/lib/compare";
import { HashPool } from "@/lib/workerPool";

// compare は 2 枚だけなのでプールは 2 本で十分（scan の大規模プールとは別インスタンス）。
const COMPARE_POOL_SIZE = 2;

type Status = "idle" | "comparing" | "done";

export function CompareScreen() {
  const [fileA, setFileA] = useState<File | null>(null);
  const [fileB, setFileB] = useState<File | null>(null);
  const [outcome, setOutcome] = useState<CompareOutcome | null>(null);
  const [status, setStatus] = useState<Status>("idle");

  const poolRef = useRef<HashPool | null>(null);
  const runningRef = useRef(false); // 二重起動防止（stale closure 回避のため ref）。
  const abortedRef = useRef(false); // アンマウント後に setState / toast しない。

  // マウントで abort を戻し（StrictMode の mount→cleanup→mount 対策）、アンマウントでプール解放。
  useEffect(() => {
    abortedRef.current = false;
    return () => {
      abortedRef.current = true;
      poolRef.current?.terminate();
      poolRef.current = null;
    };
  }, []);

  function getPool(): HashPool {
    if (!poolRef.current) poolRef.current = new HashPool(COMPARE_POOL_SIZE);
    return poolRef.current;
  }

  async function runCompare(a: File, b: File): Promise<void> {
    if (runningRef.current || abortedRef.current) return;
    runningRef.current = true;
    setStatus("comparing");
    setOutcome(null);
    try {
      const result = await compareFiles(a, b, getPool());
      if (abortedRef.current) return;
      setOutcome(result);
      setStatus("done");
    } catch (e) {
      if (abortedRef.current) return;
      toast.error("比較に失敗しました", {
        description: e instanceof Error ? e.message : String(e),
      });
      setStatus("idle");
    } finally {
      runningRef.current = false;
    }
  }

  // 片方を選び直したら、両方揃っている時点で即比較（揃うまでは待つ）。
  function pick(which: "a" | "b", file: File): void {
    const a = which === "a" ? file : fileA;
    const b = which === "b" ? file : fileB;
    (which === "a" ? setFileA : setFileB)(file);
    if (a && b) void runCompare(a, b);
    else setStatus("idle");
  }

  const comparing = status === "comparing";

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <ScreenHeader title="2 枚の画像を見比べる">
        並べて表示・境界スライダ・ピクセル差分の重ね・<span className="num">SSIM</span> /{" "}
        <span className="num">PSNR</span> を等幅数字で。ブラウザ内で完結します。
      </ScreenHeader>

      <div className="grid gap-4 md:grid-cols-2">
        <ImageSlot label="画像 A" file={fileA} onPick={(f) => pick("a", f)} disabled={comparing} />
        <ImageSlot label="画像 B" file={fileB} onPick={(f) => pick("b", f)} disabled={comparing} />
      </div>

      {comparing ? (
        <div
          className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="size-4 animate-spin" />
          比較中…
        </div>
      ) : null}

      {status === "done" && outcome && fileA && fileB ? (
        <CompareView outcome={outcome} fileA={fileA} fileB={fileB} />
      ) : null}

      {status === "idle" && !(fileA && fileB) ? (
        <p className="text-center text-sm text-muted-foreground">
          2 枚を読み込むと、総合判定と各種スコア・視覚比較を表示します。
        </p>
      ) : null}
    </div>
  );
}
