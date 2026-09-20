import { create } from "zustand";
import { toast } from "sonner";
import {
  HASH_ALGO_VERSION,
  SCHEMA_VERSION,
  type ConvertItem,
  type ConvertOptions,
  type ConvertReport,
  type ConvertStats,
} from "schema";

/** web の版（`ConvertReport.producer.appVersion`）。 */
const APP_VERSION = "0.1.6";
import {
  findOutputCollisions,
  runConvert,
  type ConvertProgress,
  type ConvertSink,
  type ConvertSource,
} from "@/lib/convert";
import { isPassThrough, normalizeOutFormat, parseHexRgb } from "@/lib/convertPlan";
import { defaultPoolSize, PoolAbortError, poolRef } from "@/lib/workerPool";
import { errText } from "@/lib/format";
import { extOf } from "@/lib/imagePaths";

// convert 画面の状態ストア（zustand）。scanStore と同じ作法:
// コンポーネント外に持つのでルート切替でも結果が残り、ワーカープールも暖まったまま使い回す。

const POOL_SIZE = defaultPoolSize();
// scan とは**別の持ち手**にする（共有すると convert の中断が走行中の scan を巻き込む）。
const pool = poolRef(POOL_SIZE);
let running = false; // 二重起動防止（描画に無関係なのでストア外）。

/**
 * 進捗の set をフレームに 1 回へ合流させる。
 *
 * `onProgress` は 1 件終わるごとに呼ばれ、各 worker の postMessage コールバック＝別マクロタスク
 * なので React は跨いでバッチしない。実測で小さい画像だと ~580 回/秒に達し、そのたびに
 * 画面全体が再描画される。進捗バーはフレームに 1 回で足りる。
 */
function rafThrottle<T>(apply: (v: T) => void): (v: T) => void {
  let latest: T | null = null;
  let scheduled = 0;
  return (v: T) => {
    latest = v;
    if (scheduled) return;
    scheduled = requestAnimationFrame(() => {
      scheduled = 0;
      if (latest !== null) apply(latest);
    });
  };
}

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
  /**
   * 利用者が画質を触ったか。**同じ形式のまま画質だけ変えて再圧縮する**指定を、
   * 「何も指定していない」と区別するために要る（参照実装の「`q` を明示したら再符号化」と同じ）。
   */
  qualityTouched: boolean;
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
  qualityTouched: false,
  destination: "folder",
  overwrite: false,
};

type ConvertState = {
  sources: ConvertSource[];
  /** 入力がフォルダのときのその handle。**出力先が同じ場所でないことを確かめる**のに使う。 */
  inputRoot: FileSystemDirectoryHandle | null;
  /** 画面に出す入力名（sources と同じ順）。 */
  form: ConvertForm;
  status: Status;
  progress: ConvertProgress;
  items: ConvertItem[];
  stats: ConvertStats | null;
  /** SPEC §5.4 が定める出力の形。画面は items/stats を直接使うが、**契約はこれ**。 */
  report: ConvertReport | null;
  setForm: (patch: Partial<ConvertForm>) => void;
  setSources: (sources: ConvertSource[]) => void;
  setInputRoot: (root: FileSystemDirectoryHandle | null) => void;
  /**
   * 実行。**出力先（sink）は呼び出し側が先に用意して渡す。**
   * 出力フォルダの選択は `showDirectoryPicker` ＝ transient activation を要るので、
   * ここで await したら手遅れ。ブラウザが実際に強制する場所（click ハンドラ）で解決させ、
   * このストアは「隠れた前提を持たない純粋な非同期編排」に保つ
   * （`DeleteDuplicatesButton` が `requestWritePermission` に対して取っているのと同じ形）。
   */
  run: (sink: ConvertSink) => Promise<void>;
  /** 実行前の検査。エラー文言を返したら実行しない。 */
  validate: () => string | null;
  /** 中断。プールを破棄して作り直す。 */
  cancel: () => void;
  reset: () => void;
};

/** フォームの生値を解決済みの `ConvertOptions` にする。`null` は入力エラー（理由つき）。 */
export function resolveOptions(form: ConvertForm): { options: ConvertOptions } | { error: string } {
  // SPEC §5.4 は w/h を u32 としている。丸めてから判定すると `0.4` が 0 になって
  // 「指定したのに何も起きない」になるので、**丸める前に整数性まで見る**。
  const MAX_DIM = 0xff_ff_ff_ff;
  const bad = (raw: string): boolean => {
    if (raw.trim() === "") return false;
    const n = Number(raw);
    return !Number.isInteger(n) || n < 1 || n > MAX_DIM;
  };
  if (bad(form.width) || bad(form.height)) {
    return { error: "幅と高さは 1 以上の整数で指定してください。" };
  }
  const num = (raw: string): number | null => (raw.trim() === "" ? null : Number(raw));
  const width = num(form.width);
  const height = num(form.height);
  const format = form.format.trim() === "" ? null : normalizeOutFormat(form.format);
  // **背景は生値のまま渡す。** 既定は出力形式で決まり、形式が「入力と同じ」のときは
  // 1 件ごとに違うので、解決はワーカー側（実際の出力形式が確定する場所）で行う。
  const raw = form.background.trim().toLowerCase();
  const background = raw === "" ? null : raw;
  // hex を指定したなら実行前に弾く（変換の途中で 1 枚ずつ失敗させない）。
  if (background != null && background !== "transparent" && background !== "average") {
    if (!parseHexRgb(background)) {
      return { error: `背景色は 6 桁の 16 進数で指定してください（例 ffffff）: ${background}` };
    }
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
      // 画質を明示したら、寸法も形式も同じでも再符号化する（素通ししない）。
      forceReencode: form.qualityTouched,
    },
  };
}

export const useConvertStore = create<ConvertState>((set, get) => ({
  sources: [],
  inputRoot: null,
  form: DEFAULT_FORM,
  status: "idle",
  progress: { processed: 0, total: 0 },
  items: [],
  stats: null,
  report: null,

  setForm: (patch) => set((s) => ({ form: { ...s.form, ...patch } })),
  setSources: (sources) => set({ sources, items: [], stats: null, report: null, status: "idle" }),
  setInputRoot: (inputRoot) => set({ inputRoot }),
  reset: () =>
    set({ sources: [], inputRoot: null, items: [], stats: null, report: null, status: "idle" }),

  cancel: () => {
    // 走行中・待機中の submit がまとめて reject され、run 側の catch が idle へ戻す。
    pool.reset("変換を中断しました");
  },

  validate: () => {
    const { sources, form } = get();
    if (sources.length === 0) return "変換する画像がありません。";
    const resolved = resolveOptions(form);
    if ("error" in resolved) return resolved.error;
    // 画質を触っていれば「同じ形式のまま再圧縮する」という明示の指定なので素通ししない。
    // 触っていないのに全件が素通しなら、やることが無い。
    if (
      !form.qualityTouched &&
      sources.every((s) => isPassThrough(resolved.options, extOf(s.path)))
    ) {
      return "変換する指定がありません（寸法・出力形式・画質のどれかを指定してください）。";
    }
    // 同じ実行の中で出力名が衝突するなら**始める前に**止める（途中で 1 枚ずつ失敗させない）。
    const collisions = findOutputCollisions(sources, resolved.options.format);
    if (collisions.length > 0) {
      const first = collisions[0];
      const more = collisions.length > 1 ? `ほか ${collisions.length - 1} 件` : "";
      return `出力名が重なります: ${first.srcs.join(" と ")} がどちらも ${first.dst} になります。${more}`;
    }
    return null;
  },

  run: async (sink: ConvertSink) => {
    if (running) return;
    const { sources, form } = get();
    const resolved = resolveOptions(form);
    if ("error" in resolved) {
      toast.error(resolved.error);
      return;
    }

    running = true;
    set({
      status: "converting",
      items: [],
      stats: null,
      report: null, // 前回の報告を残すと、失敗・中断したときに古い成功が居座る
      progress: { processed: 0, total: sources.length },
    });
    try {
      const { items, stats, vipsVersion } = await runConvert(
        sources,
        resolved.options,
        sink,
        pool.get(),
        POOL_SIZE,
        rafThrottle<ConvertProgress>((progress) => set({ progress })),
      );
      set({
        items,
        stats,
        // SPEC §5.4 の出力契約を実体として組み立てる（適用した設定の記録も兼ねる）。
        report: {
          schemaVersion: SCHEMA_VERSION,
          kind: "convert",
          producer: {
            app: "web",
            appVersion: APP_VERSION,
            vips: vipsVersion || "wasm-vips",
            hashAlgo: HASH_ALGO_VERSION,
          },
          root: get().inputRoot?.name ?? "",
          createdAt: new Date().toISOString(),
          options: resolved.options,
          items,
          stats,
        },
        status: "done",
      });
      if (stats.failed > 0) {
        toast.warning(
          `${stats.converted} 件を変換（${stats.failed} 件失敗・${stats.skipped} 件 skip）`,
        );
      } else {
        toast.success(`${stats.converted} 件を変換しました（${stats.skipped} 件 skip）`);
      }
    } catch (e) {
      // 中断（プール破棄）と、編排自体の失敗を区別する。1 件ごとの変換失敗はここへ来ない
      // （`runConvert` が per-file に記録して正常終了する）。
      set({ status: "idle" });
      if (e instanceof PoolAbortError) {
        toast.info("変換を中断しました");
      } else {
        toast.error("変換を中止しました", { description: errText(e) });
      }
    } finally {
      running = false;
    }
  },
}));
