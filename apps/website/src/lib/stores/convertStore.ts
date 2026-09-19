import { create } from "zustand";
import { toast } from "sonner";
import type { ConvertItem, ConvertOptions, ConvertStats } from "schema";
import { runConvert, type ConvertProgress, type ConvertSource } from "@/lib/convert";
import { folderSink, zipSink } from "@/lib/convertSinks";
import { effectiveBackground, normalizeOutFormat, parseHexRgb } from "@/lib/convertPlan";
import { pickDirectory } from "@/lib/fsaccess";
import { defaultPoolSize, poolRef } from "@/lib/workerPool";

// convert 画面の状態ストア（zustand）。scanStore と同じ作法:
// コンポーネント外に持つのでルート切替でも結果が残り、ワーカープールも暖まったまま使い回す。

const POOL_SIZE = defaultPoolSize();
// scan とは**別の持ち手**にする（共有すると convert の中断が走行中の scan を巻き込む）。
const pool = poolRef(POOL_SIZE);
let running = false; // 二重起動防止（描画に無関係なのでストア外）。

type Status = "idle" | "converting" | "done";

/** 出力の落とし先。入力フォルダには決して書かない（SPEC §5.4）。 */
export type Destination = "folder" | "zip";

/** UI が持つ生の入力（未確定の値を含む）。実行時に `ConvertOptions` へ解決する。 */
export type ConvertForm = {
  width: string;
  height: string;
  fit: ConvertOptions["fit"];
  gravity: ConvertOptions["gravity"];
  /** 空文字は「形式ごとの既定」。`transparent` / `average` / 6 桁 hex。 */
  background: string;
  /** 空文字は「入力と同じ形式」。 */
  format: string;
  quality: number;
  destination: Destination;
  /** 出力先に同名が在るとき上書きするか（既定は安全側の false＝ skip）。 */
  overwrite: boolean;
};

export const DEFAULT_FORM: ConvertForm = {
  width: "",
  height: "",
  fit: "cover",
  gravity: "center",
  background: "",
  format: "",
  quality: 80,
  destination: "folder",
  overwrite: false,
};

type ConvertState = {
  sources: ConvertSource[];
  /** 画面に出す入力名（sources と同じ順）。 */
  form: ConvertForm;
  status: Status;
  progress: ConvertProgress;
  items: ConvertItem[];
  stats: ConvertStats | null;
  setForm: (patch: Partial<ConvertForm>) => void;
  setSources: (sources: ConvertSource[]) => void;
  /** 実行（**click の同期continuation から呼ぶこと** — 出力フォルダ選択が transient activation を要る）。 */
  run: () => Promise<void>;
  /** 中断。プールを破棄して作り直す。 */
  cancel: () => void;
  reset: () => void;
};

/** フォームの生値を解決済みの `ConvertOptions` にする。`null` は入力エラー（理由つき）。 */
export function resolveOptions(form: ConvertForm): { options: ConvertOptions } | { error: string } {
  const num = (s: string): number | null => {
    if (s.trim() === "") return null;
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : Number.NaN;
  };
  const width = num(form.width);
  const height = num(form.height);
  if (Number.isNaN(width) || Number.isNaN(height)) {
    return { error: "幅と高さは 1 以上の数値で指定してください。" };
  }
  const format = form.format.trim() === "" ? null : normalizeOutFormat(form.format);
  const background = effectiveBackground(form.background, format ?? "");
  // hex を指定したなら実行前に弾く（変換の途中で 1 枚ずつ失敗させない）。
  if (background !== "transparent" && background !== "average" && !parseHexRgb(background)) {
    return { error: `背景色は 6 桁の 16 進数で指定してください（例 ffffff）: ${background}` };
  }
  return {
    options: {
      width,
      height,
      fit: form.fit,
      gravity: form.gravity,
      background,
      format,
      quality: form.quality,
    },
  };
}

export const useConvertStore = create<ConvertState>((set, get) => ({
  sources: [],
  form: DEFAULT_FORM,
  status: "idle",
  progress: { processed: 0, total: 0 },
  items: [],
  stats: null,

  setForm: (patch) => set((s) => ({ form: { ...s.form, ...patch } })),
  setSources: (sources) => set({ sources, items: [], stats: null, status: "idle" }),
  reset: () => set({ sources: [], items: [], stats: null, status: "idle" }),

  cancel: () => {
    // 走行中・待機中の submit がまとめて reject され、run 側の catch が idle へ戻す。
    pool.reset("変換を中断しました");
  },

  run: async () => {
    if (running) return;
    const { sources, form } = get();
    if (sources.length === 0) return;

    const resolved = resolveOptions(form);
    if ("error" in resolved) {
      toast.error(resolved.error);
      return;
    }

    // **出力先の選択はネットワークも await も挟まずここで**。showDirectoryPicker は
    // transient activation（click の直後）でしか開けないので、変換してから聞くのでは遅い。
    let sink;
    if (form.destination === "folder") {
      const root = await pickDirectory("readwrite").catch(() => null);
      if (!root) {
        toast.error("出力先フォルダが選ばれませんでした。");
        return;
      }
      sink = folderSink(root, form.overwrite);
    } else {
      sink = zipSink("imgdiff-converted.zip");
    }

    running = true;
    set({
      status: "converting",
      items: [],
      stats: null,
      progress: { processed: 0, total: sources.length },
    });
    try {
      const { items, stats } = await runConvert(
        sources,
        resolved.options,
        sink,
        pool.get(),
        POOL_SIZE,
        (progress) => set({ progress }),
      );
      set({ items, stats, status: "done" });
      if (stats.failed > 0) {
        toast.warning(
          `${stats.converted} 件を変換（${stats.failed} 件失敗・${stats.skipped} 件 skip）`,
        );
      } else {
        toast.success(`${stats.converted} 件を変換しました（${stats.skipped} 件 skip）`);
      }
    } catch (e) {
      // 中断（プール破棄）もここに来る。結果は捨てて idle へ戻す。
      set({ status: "idle" });
      toast.error("変換を中止しました", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      running = false;
    }
  },
}));
