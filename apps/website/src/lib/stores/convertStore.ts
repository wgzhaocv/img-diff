import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
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
  convertSource,
  findOutputCollisions,
  runBounded,
  runConvert,
  type ConvertProgress,
  type ConvertSink,
  type ConvertSource,
} from "@/lib/convert";
import {
  FIT_VALUES,
  GRAVITY_VALUES,
  mimeOf,
  cannotWriteReason,
  WRITABLE_FORMATS,
} from "@/lib/convertControls";
import type { ConvertResult, InfoResult } from "@/lib/hashTypes";
import {
  clampQuality,
  isBadDim,
  isPassThrough,
  normalizeOutFormat,
  parseDim,
  parseHexRgb,
  planGeometry,
} from "@/lib/convertPlan";
import { defaultPoolSize, PoolAbortError, poolRef } from "@/lib/workerPool";
import { errText } from "@/lib/format";
import { rafThrottle } from "@/lib/rafThrottle";
import { extOf } from "@/lib/imagePaths";

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
  /**
   * 利用者が画質を触ったか。**同じ形式のまま画質だけ変えて再圧縮する**指定を、
   * 「何も指定していない」と区別するために要る（参照実装の「`q` を明示したら再符号化」と同じ）。
   */
  qualityTouched: boolean;
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
  overwrite: false,
};

/**
 * **次に開いたときも残す設定**と、その検証。
 *
 * 表を 1 つにする —— 残す鍵の一覧と、戻すときの検証を別々に書くと、
 * 欄を足したときに片方だけ古くなる（保存はされるのに黙って捨てられる、が起きる）。
 *
 * 入れていない物には理由がある:
 * - `width` / `height`: 画像に付随する値。毎回その画像の原寸から始める
 *   （前回の 1280 が今回の画像にとって意味を持つとは限らない）。
 * - `overwrite`: 破壊的になり得る切替は既定を安全側に戻す（UI.md §6.1）。
 * - 出力先（フォルダ / zip）: **フォームの値ではない**。押したボタンがその場で決める
 *   （`ConvertDestination`）ので、覚えておいても画面に出す先が無い。
 *
 * `quality` と `qualityTouched` は**対で**残す（片方だけ戻ると、画質が復活したのに
 * 再符号化されない＝黙って無視される状態になる）。
 */
const REMEMBERED: {
  [K in keyof RememberedForm]: (v: unknown) => RememberedForm[K] | undefined;
} = {
  fit: (v) =>
    typeof v === "string" && (FIT_VALUES as string[]).includes(v)
      ? (v as ConvertForm["fit"])
      : undefined,
  gravity: (v) =>
    typeof v === "string" && (GRAVITY_VALUES as string[]).includes(v)
      ? (v as ConvertForm["gravity"])
      : undefined,
  // 背景は自由入力（transparent / average / hex）。実行前に resolveOptions が弾くので、
  // ここでは「文字列で、UI が壊れない長さ」だけ見る。
  background: (v) => (typeof v === "string" && v.length <= 32 ? v : undefined),
  format: (v) =>
    typeof v === "string" && (v === "" || WRITABLE_FORMATS.includes(v)) ? v : undefined,
  quality: (v) => (typeof v === "number" ? clampQuality(v) : undefined),
  qualityTouched: (v) => (typeof v === "boolean" ? v : undefined),
};

/** 記憶する部分だけの形。ここに欄を足すと `REMEMBERED` の検証も必須になる（型で強制される）。 */
export type RememberedForm = Omit<ConvertForm, "width" | "height" | "overwrite">;

/** 保存する値を取り出す。 */
export function rememberedForm(form: ConvertForm): RememberedForm {
  const out = {} as Record<string, unknown>;
  for (const key of Object.keys(REMEMBERED)) out[key] = form[key as keyof ConvertForm];
  return out as RememberedForm;
}

/**
 * localStorage から戻した値を検証する。**手で書き換えられていても画面を壊さない**ため、
 * 表に在る鍵だけを、取り得る値まで見て通す（未知・不正は既定のまま）。
 */
export function sanitizeStoredForm(raw: unknown): Partial<ConvertForm> {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, check] of Object.entries(REMEMBERED)) {
    const v = check(r[key]);
    if (v !== undefined) out[key] = v;
  }
  // **対でなければどちらも捨てる。** 片方だけ戻ると「画質 20 と表示されているのに
  // 素通しして効かない」「既定値で黙って再符号化する」という食い違いになる。
  if ("quality" in out !== "qualityTouched" in out) {
    delete out.quality;
    delete out.qualityTouched;
  }
  return out as Partial<ConvertForm>;
}

/** 入力 1 件の見た目の情報（サムネ・原寸・バイト数）。worker の `op:"hash"` が一度に返す。 */
export type SourceInfo = {
  /** ~256px の webp。デコードできなかったときは無し。 */
  thumb?: Blob;
  /** 原寸（EXIF の向き適用後）。デコードできなかったときは 0。 */
  width: number;
  height: number;
  bytes: number;
};

/** サムネを一度に取りに行く件数。「もっと見る」でこの単位ずつ伸びる。 */
export const SOURCE_INFO_PAGE = 12;

/**
 * サムネ取得が飛んでいる path。**選び直しと二重起動で同じ画像を二度デコードしない**ため。
 * 描画に関係しないのでストア外に置く（`running` と同じ扱い）。
 */
const infoInflight = new Set<string>();
/**
 * 選び直しの世代。**古い選択の結果が新しい選択へ紛れ込むのを防ぐ**。
 * サムネもプレビューもこの 1 本を見る（プレビューは同時に 1 本しか走らないので、
 * 「設定を変えたから古い結果を捨てる」用の別カウンタは要らない）。
 */
let sourcesGen = 0;
/**
 * プレビューは**常に 1 枚だけ**走らせる。走行中の要求は「最後の 1 回」だけ覚えておき、
 * 終わってからやり直す（スライダを掴んで動かしても、変換が積み上がらない）。
 * 画面に関係しないのでストア外に置く（`running` と同じ扱い）。
 */
let previewBusy = false;
let previewQueued = false;
/** 原寸の自動流し込みを済ませた世代（選び直しごとに一度だけ行う）。 */
let prefilledGen = -1;
/**
 * エンジンの先起こし。**走っている間の再入を防ぐ**ので、画面が何度 mount しても
 * ダウンロードは 1 回で済む。選び直しでは捨てない（wasm は使い回す）。
 */
let warming: Promise<void> | null = null;

/** プレビュー 1 枚ぶんの結果（実際に変換して得たもの。推定値ではない）。 */
export type PreviewResult = {
  path: string;
  /** 変換後のバイト列。ブラウザが描けない形式（jxl / tiff / ppm）でも数値は正しい。 */
  blob: Blob;
  width: number;
  height: number;
  bytes: number;
  /** 実際の出力形式（正規化済み）。 */
  format: string;
  /** 再符号化せず元のバイト列をそのまま出した（SPEC §5.4 規則 4）。 */
  passedThrough: boolean;
  /**
   * どの入力から作ったか（`previewKey`）。**path だけで突き合わせると、
   * 設定を変えた直後や失敗したときに古い絵を「今の結果」として保存・コピーできてしまう。**
   */
  key: string;
};

/**
 * wasm-vips の準備段階。`"cold"` は「まだ起こしていない」で、失敗もここへ戻る
 * （前倒しの失敗は報せない —— 本当の理由は実際に変換したときに同じ経路で出る）。
 */
export type EnginePhase = "cold" | "loading" | "ready";

export type ConvertState = {
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
  /** 取得できた入力の見た目情報（path → サムネ・原寸）。先頭から `infoLimit` 件ぶん。 */
  sourceInfo: Map<string, SourceInfo>;
  /** サムネを取りに行った件数（先頭から）。 */
  infoLimit: number;
  /** プレビューに使う 1 枚（未指定なら先頭）。サムネを押すと変わる。 */
  previewPath: string | null;
  /** 直近のプレビュー結果。設定を変えるたびに作り直す。 */
  preview: PreviewResult | null;
  /** プレビューを作っている最中か（結果は `preview`、失敗は `previewError`）。 */
  previewRendering: boolean;
  /**
   * 直近の失敗。**どの入力に対する失敗かを鍵ごと持つ** —— 文字列だけだと、設定を変えた後も
   * 古い理由が新しい絵の横に残り、「押せない理由」としても効いてしまう。
   */
  previewError: { key: string; message: string } | null;
  /**
   * wasm-vips の準備段階。**「エンジンを読んでいる」と「変換している」を画面で区別する**
   * ための唯一の出所。選び直しでは戻さない（一度起きたエンジンは使い回す）。
   */
  engine: EnginePhase;
  /**
   * 画面を開いた時点でエンジンを起こす。**二度呼んでも 1 回しか走らない。**
   * 画像を選んでいる間にダウンロード（約 11.9MB）を重ねるのが目的（DESIGN §7.2）。
   */
  warmEngine: () => Promise<void>;
  setPreviewPath: (path: string | null) => void;
  setForm: (patch: Partial<ConvertForm>) => void;
  setSources: (sources: ConvertSource[]) => void;
  setInputRoot: (root: FileSystemDirectoryHandle | null) => void;
  /**
   * 先頭 `upTo` 件のサムネと原寸を取る。**表示する分しか取らない**
   * （数千枚のフォルダで全件デコードしないため）。先頭 1 枚が返った時点で寸法欄に原寸を入れる。
   */
  loadSourceInfo: (upTo: number) => Promise<void>;
  /**
   * 実行。**出力先（sink）は呼び出し側が先に用意して渡す。**
   * 出力フォルダの選択は `showDirectoryPicker` ＝ transient activation を要るので、
   * ここで await したら手遅れ。ブラウザが実際に強制する場所（click ハンドラ）で解決させ、
   * このストアは「隠れた前提を持たない純粋な非同期編排」に保つ。
   *
   * **`options` は押した瞬間の値**を渡すこと。出力先を選んでいる間にフォームが動くことがある
   * （サムネの到着で寸法が入る等）ので、ここで読み直すと「押したときと違う変換」になる。
   */
  run: (sink: ConvertSink, options: ConvertOptions) => Promise<void>;
  /**
   * 今の設定で**実際に 1 枚だけ変換して**プレビューを作る（推定ではなく本物を見せる）。
   * 変換の実行中は何もしない —— 同じプールを奪い合わないため。
   */
  renderPreview: () => Promise<void>;
  /**
   * プレビューの結果を**クリップボードが受け取れる形（png）**で返す。
   *
   * ブラウザのクリップボードは画像として png しか受け取らない（jpeg / webp を渡すと
   * `Type ... not supported on write` で失敗する）。貼り付け先が欲しいのは「絵」であって
   * ファイル形式ではないので、**png 以外は見えている結果をそのまま png へ包み直す**
   * （寸法も画素も変えない）。
   */
  previewAsPng: () => Promise<Blob>;
  /** 実行前の検査（安い側）。エラー文言を返したら実行しない。 */
  validate: () => string | null;
  /**
   * 出力名の衝突検査（**全件を舐める**）。`sources` と出力形式でしか変わらないので
   * `validate` と分けてある —— 文字を 1 つ打つたびに数千件を再走査しないため。
   */
  validateCollisions: () => string | null;
  /** 中断。プールを破棄して作り直す。 */
  cancel: () => void;
  reset: () => void;
};

/**
 * その 1 枚が**この設定では書き出せない**なら理由を返す。
 * `validate` とプレビューが**同じ答え**を出すために、原寸の有無の扱いまでここに閉じる。
 */
function writeBlockFor(state: ConvertState, options: ConvertOptions, path: string): string | null {
  const info = state.sourceInfo.get(path);
  return cannotWriteReason(
    options,
    extOf(path),
    info && info.width > 0 ? plannedOutput(options, info) : undefined,
  );
}

/** この設定でその画像がどうなるか（計画から。画素には触らない）。 */
function plannedOutput(
  options: ConvertOptions,
  src: { width: number; height: number },
): { noop: boolean; width: number; height: number } {
  const plan = planGeometry({
    srcW: src.width,
    srcH: src.height,
    width: options.width,
    height: options.height,
    fit: options.fit,
    gravity: options.gravity,
  });
  const noop = plan.kind === "noop";
  switch (plan.kind) {
    case "noop":
      return { noop, ...src };
    case "cover":
      return { noop, width: plan.crop.width, height: plan.crop.height };
    case "contain":
      return { noop, width: plan.embed.width, height: plan.embed.height };
    default:
      return { noop, width: plan.width, height: plan.height };
  }
}

/**
 * プレビューと原寸の基準にする 1 枚（サムネで選べる。未選択なら先頭）。
 * **3 つの画面部品が同じ 1 枚を指す**必要があるので、選び方はここに 1 つだけ置く。
 */
export const representativePath = (s: ConvertState): string | undefined =>
  s.previewPath ?? s.sources[0]?.path;

/**
 * **プレビューを作り直すべき入力**の同一性。これが変わらなければ結果は 1 バイトも変わらない。
 *
 * `form` 全体を見張ると、出力に関係しない欄（保存先・上書き）を触っただけで
 * 4000×3000 の再変換が走る。実際に効くのは「代表 1 枚」と「解決済みの `ConvertOptions`」だけ。
 */
export function previewKey(s: ConvertState): string {
  const path = representativePath(s) ?? "";
  const resolved = resolveOptions(s.form);
  // **原寸も含める。** 大きすぎるかどうかの判定は原寸に依るので、サムネが届いた時点で
  // 作り直さないと「ボタンの下は理由を出しているのに、絵の側は実際に走って落ちる」になる。
  const info = path === "" ? undefined : s.sourceInfo.get(path);
  const dims = info ? `${info.width}x${info.height}` : "?";
  return "error" in resolved
    ? `invalid:${path}`
    : `${path}\n${dims}\n${JSON.stringify(resolved.options)}`;
}

/**
 * **今の設定で 1 枚を試し終えたか。** 保存ボタンはこれが立つまで押せない
 * （変換の結果を見ないまま書き出させない・UI.md §6.1）。
 *
 * 「成功したか」ではなく「試し終えたか」で見る —— 代表 1 枚が書けない形式でも、
 * バッチの残りは変換できる。全件が駄目なときは `validate` が別に止める。
 */
export function previewSettled(s: ConvertState): boolean {
  // 変換中は押せないので判定も要らない。**進捗は秒間数百回**更新されるので、
  // ここで毎回 `previewKey` を組み立てないように先に切る。
  if (s.previewRendering || s.status === "converting") return false;
  const key = previewKey(s);
  return s.preview?.key === key || s.previewError?.key === key;
}

/**
 * **表単が最終形になったか。** 代表 1 枚の原寸が届き、寸法欄への書き戻し
 * （`prefillDimensions`）が済んだかを見る。
 *
 * これが false の間は、表単は「まだ埋まっていない中間態」—— 寸法が空で出力形式も
 * 「入力と同じ」なら `validate` は「変換する指定がありません」を返すが、それは
 * **利用者が何もしていないうちに出す警告**になる（原寸が届けば寸法が入って消える）。
 * 判定そのものは消さず、出すのを待つためだけに使う。
 */
export function formSettled(s: ConvertState): boolean {
  const path = representativePath(s);
  return path != null && s.sourceInfo.has(path);
}

/** フォームの生値を解決済みの `ConvertOptions` にする。`null` は入力エラー（理由つき）。 */
export function resolveOptions(form: ConvertForm): { options: ConvertOptions } | { error: string } {
  // 読み取りの規則は convertPlan（parseDim）が正本。画面の表示判定と同じ物を使う。
  if (isBadDim(form.width) || isBadDim(form.height)) {
    return { error: "幅と高さは 1 以上の整数で指定してください。" };
  }
  const width = parseDim(form.width);
  const height = parseDim(form.height);
  const format = form.format.trim() === "" ? null : normalizeOutFormat(form.format);
  // **背景は生値のまま渡す。** 既定は出力形式で決まり、形式が「入力と同じ」のときは
  // 1 件ごとに違うので、解決はワーカー側（実際の出力形式が確定する場所）で行う。
  const raw = form.background.trim().toLowerCase();
  const background = raw === "" ? null : raw;
  // hex を指定したなら実行前に弾く（変換の途中で 1 枚ずつ失敗させない）。
  // **使われるときだけ**見る —— 背景は contain の余白にしか使わないので、cover に切り替えた
  // 利用者が「もう見えない欄の打ち間違い」で実行を止められるのはおかしい。
  const backgroundUsed = form.fit === "contain" && width != null && height != null;
  if (
    backgroundUsed &&
    background != null &&
    background !== "transparent" &&
    background !== "average"
  ) {
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

/** 選び直し・全消しで共通に戻す部分（結果とサムネは持ち越さない）。**毎回新しく作る**。 */
const cleared = (): Pick<
  ConvertState,
  | "sourceInfo"
  | "infoLimit"
  | "previewPath"
  | "preview"
  | "previewRendering"
  | "previewError"
  | "items"
  | "stats"
  | "report"
  | "status"
> => ({
  sourceInfo: new Map(),
  infoLimit: 0,
  previewPath: null,
  preview: null,
  previewRendering: false,
  previewError: null,
  items: [],
  stats: null,
  report: null,
  status: "idle",
});

/**
 * 代表画像の原寸が分かった時点で寸法欄を埋める。**まだ空のときだけ**
 * （取得を待つ間に利用者が打ち始めていたら、それを上書きしない）。
 */
function prefillDimensions(
  path: string,
  info: SourceInfo,
  get: () => ConvertState,
  set: (patch: Partial<ConvertState>) => void,
): void {
  // **選び直しごとに一度だけ。** 後から届いた原寸が、利用者が意図的に空にした欄を
  // 埋め直す（＝黙って変換内容が変わる）ことを防ぐ。
  if (prefilledGen === sourcesGen) return;
  if (info.width <= 0 || path !== representativePath(get())) return;
  const form = get().form;
  if (form.width.trim() !== "" || form.height.trim() !== "") return;
  prefilledGen = sourcesGen;
  set({ form: { ...form, width: String(info.width), height: String(info.height) } });
}

/**
 * 進捗の set をフレームに 1 回へ合流させる持ち手。**実行ごとに作らない** ——
 * 作り直すと前回の予約フレームを取り消せず、新しい実行の「0 / N」を古い値で上書きし得る。
 */
const onProgress = rafThrottle<ConvertProgress>((progress) =>
  useConvertStore.setState({ progress }),
);

export const useConvertStore = create<ConvertState>()(
  persist(
    (set, get) => ({
      sources: [],
      inputRoot: null,
      form: DEFAULT_FORM,
      status: "idle",
      progress: { processed: 0, total: 0 },
      items: [],
      stats: null,
      report: null,
      sourceInfo: new Map(),
      infoLimit: 0,
      previewPath: null,
      preview: null,
      previewRendering: false,
      previewError: null,
      engine: "cold",

      /**
       * **画像を渡さずにワーカー 1 本だけ起こす。**
       *
       * 起こすのが 1 本なのは、実体ごとに 1GiB の線形メモリを予約する（DESIGN §7.1）ため。
       * 残りはバッチ実行時に自然に起きるが、そのときには HTTP キャッシュが温まっているので
       * ダウンロードは要らない。
       *
       * `pool.hold()` を取るのは、画面切替の `releaseIdlePools()` が
       * **温めている最中のプールを畳まない**ようにするため（キューは空なので暇に見える）。
       *
       * **毎回投げてよい。** 二度目が無駄にならないのは、ワーカー側の `getVips()` が
       * 実体を記憶しているから（既に温まっていれば往復 1 回で即返る）。ここで
       * 「`engine === "ready"` なら投げない」と早切りすると、画面を離れて戻ったときに
       * `releaseIdlePools()` がプールを畳んでいても温かいと言い続けてしまう。
       * 畳まないのは走行中だけなので、暇なときに畳まれるのは正常な経路。
       */
      warmEngine: () => {
        // 走っている 1 本に畳む（画面が二度 mount してもダウンロードは重ねない）。
        if (warming) return warming;
        const releaseHold = pool.hold();
        // 温かいまま再度起こすときは段階を戻さない（一瞬だけ「読み込み中」が瞬くのを防ぐ）。
        if (get().engine !== "ready") set({ engine: "loading" });
        warming = (async () => {
          try {
            await pool.get().submit({ op: "warm" }, []);
            set({ engine: "ready" });
          } catch {
            // 前倒しの失敗は報せない（利用者が頼んだ仕事ではない）。次の機会に起こし直す。
            set({ engine: "cold" });
          } finally {
            releaseHold();
            warming = null;
          }
        })();
        return warming;
      },

      setForm: (patch) => set((s) => ({ form: { ...s.form, ...patch } })),
      setSources: (sources) => {
        sourcesGen += 1;
        previewQueued = false;
        infoInflight.clear();
        // **寸法は毎回リセットする。** 選び直したら新しい画像の原寸から始める（記憶もしない）。
        set((s) => ({ ...cleared(), sources, form: { ...s.form, width: "", height: "" } }));
      },
      setInputRoot: (inputRoot) => set({ inputRoot }),
      // 選び直しと同じ後始末に、入力フォルダの忘却を足すだけ。
      reset: () => {
        get().setSources([]);
        set({ inputRoot: null });
      },

      setPreviewPath: (previewPath) => set({ previewPath }),

      previewAsPng: async () => {
        const preview = get().preview;
        if (!preview) throw new Error("プレビューがまだありません");
        if (preview.format === "png") return preview.blob;
        // 見えている結果そのものを包み直す（元画像から作り直すと、設定次第で別物になり得る）。
        const bytes = await preview.blob.arrayBuffer();
        const res = (await pool.get().submit(
          {
            op: "convert",
            path: preview.path,
            bytes,
            options: {
              width: null,
              height: null,
              fit: "cover",
              gravity: "center",
              background: null,
              format: "png",
              quality: 100,
              // 形式を変えるので素通しにはならないが、意図を明示しておく。
              forceReencode: true,
            },
            srcFormat: preview.format,
          },
          [bytes],
        )) as ConvertResult;
        if (res.error != null || !res.out) {
          throw new Error(res.error ?? "png に変換できませんでした");
        }
        return new Blob([res.out], { type: mimeOf("png") });
      },

      renderPreview: async () => {
        const state = get();
        // 本番の変換とプールを奪い合わない。**要求は覚えておき**、終わってからやり直す。
        if (state.status === "converting") {
          previewQueued = true;
          return;
        }
        // 走行中なら「もう一度やる」とだけ覚えて戻る（要求を溜め込まない）。
        if (previewBusy) {
          previewQueued = true;
          return;
        }
        const path = representativePath(state);
        const at = state.sources.findIndex((s) => s.path === path);
        const src = at < 0 ? undefined : state.sources[at];
        if (!src) return;
        // **原寸が届くまでは作らない。** 理由は 2 つあって、どちらも原寸が
        // `previewKey` の一部だから起きる（サムネと一緒に後から届く）:
        //   1. 原寸は「大きすぎて書けない」判定の入力（`writeBlockFor`）。知らないまま走らせると、
        //      押す前に止めるはずの変換をプレビューだけが走らせてしまう。
        //   2. 届いた瞬間に鍵が変わる（寸法欄も原寸で埋まる・`prefillDimensions`）ので、
        //      先に始めた分は**捨てるために符号化する**ことになる。実測 1024×1024 の avif で
        //      4.2s → 8.5s。「選んだ直後だけ倍遅い」の正体はこれ。
        if (!state.sourceInfo.has(src.path)) {
          // **無いなら催促する。** ここで黙って戻るだけにすると、中断でこの 1 枚の要求だけが
          // 落ちていた場合（`loadSourceInfo` は中断を記録しない）、鍵が二度と変わらないので
          // プレビューも保存ボタンも永久に止まる —— 「もっと見る」が無い枚数だと戻す手も無い。
          // 取得中・取得済みは `loadSourceInfo` 側が弾くので、何度呼んでも二重には走らない。
          void get().loadSourceInfo(at + 1);
          return;
        }
        const resolved = resolveOptions(state.form);
        // 入力が不正なときは黙って前の絵を残す（理由は実行ボタンの下に出ている）。
        if ("error" in resolved) return;

        const srcFormat = extOf(src.path);
        const key = previewKey(state);
        // 書けない・大きすぎるなら試さずに理由を出す（実行ボタンの下と同じ文言を絵の側でも）。
        const reason = writeBlockFor(state, resolved.options, src.path);
        if (reason) {
          set({ previewRendering: false, previewError: { key, message: reason } });
          return;
        }

        const gen = sourcesGen;
        previewBusy = true;
        const releaseHold = pool.hold();
        set({ previewRendering: true, previewError: null });
        try {
          // **本番と同じ入口を通す**（素通し判定も含めて）。別に書くと「プレビューだけ違う」が生まれる。
          const out = await convertSource(src, resolved.options, pool.get());
          if (gen !== sourcesGen) return; // 選び直された後に返ってきた結果は捨てる
          const format = normalizeOutFormat(resolved.options.format ?? srcFormat);
          // 素通しは寸法を返さない（デコードしていない）ので、サムネ取得時の原寸を使う。
          const info = get().sourceInfo.get(src.path);
          set({
            preview: {
              path: src.path,
              blob: new Blob([out.data], { type: mimeOf(format) }),
              width: out.passedThrough ? (info?.width ?? 0) : out.width,
              height: out.passedThrough ? (info?.height ?? 0) : out.height,
              bytes: out.data.byteLength,
              format,
              passedThrough: out.passedThrough,
              key,
            },
          });
        } catch (e) {
          if (gen !== sourcesGen) return;
          // 中断（プール破棄）はプレビューの失敗ではない。
          // 中断はプレビューの失敗ではないが、**鍵に対する答えは必ず書く** ——
          // 黙って戻ると成功でも失敗でもない宙ぶらりんになり、保存ボタンが押せないまま固まる。
          // やり直さないのは、止めろと言われた仕事をすぐ始め直さないため
          // （画面に戻れば `ConvertPreview` の効果が改めて呼ぶ）。
          if (e instanceof PoolAbortError) {
            set({ previewError: { key, message: "中断しました" } });
            return;
          }
          set({ previewError: { key, message: errText(e) } });
        } finally {
          releaseHold();
          previewBusy = false;
          set({ previewRendering: false });
          if (previewQueued) {
            previewQueued = false;
            void get().renderPreview();
          }
        }
      },

      loadSourceInfo: async (upTo) => {
        const sources = get().sources;
        const limit = Math.max(get().infoLimit, Math.max(0, Math.min(upTo, sources.length)));
        const gen = sourcesGen;
        // **上限が伸びていなくても、取れていない分は取り直す**（中断で落ちた要求が
        // 「読み込み済み」のまま欠けたままにならないように）。
        const want = sources
          .slice(0, limit)
          .filter((s) => !get().sourceInfo.has(s.path) && !infoInflight.has(s.path));
        if (want.length === 0) {
          set({ infoLimit: limit });
          return;
        }
        set({ infoLimit: limit });
        for (const s of want) infoInflight.add(s.path);
        const releaseHold = pool.hold();

        // 同時に読む数を絞る。並列度ではなく**メモリ**が目的（1 件ごとにファイル全体を読む）。
        // **ワーカーを 1 本空けておく**: 全部埋めると、利用者が見ているプレビューが
        // 12 枚のサムネの後ろに並んで最後に出てくる。
        await runBounded(want, Math.max(1, POOL_SIZE - 1), async (src) => {
          try {
            if (gen !== sourcesGen) return; // 選び直された: 読む前にやめる
            const bytes = await src.bytes();
            const res = (await pool
              .get()
              .submit({ op: "info", path: src.path, bytes }, [bytes])) as InfoResult;
            if (gen !== sourcesGen) return; // 選び直された後に返ってきた結果は捨てる
            const info: SourceInfo = {
              thumb: res.thumb ? new Blob([res.thumb], { type: mimeOf("webp") }) : undefined,
              width: res.width,
              height: res.height,
              bytes: res.bytes,
            };
            set((s) => ({ sourceInfo: new Map(s.sourceInfo).set(src.path, info) }));
            prefillDimensions(src.path, info, get, set);
          } catch (e) {
            // サムネは無くても変換はできるので、失敗そのものは報せない。
            // ただし**答えは必ず残す** —— プレビューは原寸が記録されるまで動かないので、
            // 何も書かずに終わるとそこで止まってしまう（ファイルが読めなかった場合など。
            // デコード失敗はワーカーが原寸 0 で返してくるのでここには来ない）。
            // 中断だけは記録しない ——「変換を中断した」のであってサムネの失敗ではなく、
            // 次の `loadSourceInfo` で取り直させたいため。
            if (!(e instanceof PoolAbortError) && gen === sourcesGen) {
              const failed: SourceInfo = { width: 0, height: 0, bytes: 0 };
              set((s) => ({ sourceInfo: new Map(s.sourceInfo).set(src.path, failed) }));
            }
          } finally {
            infoInflight.delete(src.path);
          }
        });
        releaseHold();
      },

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
        // **書けない / 大きすぎる**を実行前に止めるのは、**全件が駄目なとき**だけ。
        // 1 枚の heic を巻き添えに 999 枚を止めない（昔どおり per-file の失敗として記録する）。
        // 書ける 1 枚が見つかった時点で打ち切る（数千枚で毎回全件の計画を立て直さない）。
        const state = get();
        let first: string | null = null;
        for (const src of sources) {
          const reason = writeBlockFor(state, resolved.options, src.path);
          if (reason == null) return null;
          first ??= reason;
        }
        return first;
      },

      validateCollisions: () => {
        const { sources, form } = get();
        const resolved = resolveOptions(form);
        if ("error" in resolved) return null; // 先に validate が理由を返している
        // 同じ実行の中で出力名が衝突するなら**始める前に**止める（途中で 1 枚ずつ失敗させない）。
        const collisions = findOutputCollisions(sources, resolved.options.format);
        if (collisions.length === 0) return null;
        const first = collisions[0];
        const more = collisions.length > 1 ? `ほか ${collisions.length - 1} 件` : "";
        return `出力名が重なります: ${first.srcs.join(" と ")} がどちらも ${first.dst} になります。${more}`;
      },

      run: async (sink: ConvertSink, options: ConvertOptions) => {
        if (running) return;
        const sources = get().sources;
        if (sources.length === 0) return;

        running = true;
        const releaseHold = pool.hold(); // 走行中は畳ませない（画面を離れても最後まで走る）
        onProgress.cancel(); // 前回の予約フレームが新しい実行の 0/N を上書きしないように
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
            options,
            sink,
            pool.get(),
            POOL_SIZE,
            onProgress,
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
              options,
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
          releaseHold();
          // 変換中は見送っていたプレビューと、中断で落ちたサムネをここで拾い直す。
          void get().loadSourceInfo(get().infoLimit);
          if (previewQueued) {
            previewQueued = false;
            void get().renderPreview();
          }
        }
      },
    }),
    {
      name: "imgdiff.convert",
      version: 1,
      // 保存できない環境でも**画面は動き続ける**こと。
      // createJSONStorage は「localStorage を取れない」場合は面倒を見てくれるが、
      // **書き込みが投げる**場合（Quota 超過・SecurityError）は素通しする。zustand は
      // set のたびに保存するので、そこで投げると変換の開始処理ごと巻き添えになる。
      storage: createJSONStorage(() => ({
        getItem: (k) => localStorage.getItem(k),
        setItem: (k, v) => {
          try {
            localStorage.setItem(k, v);
          } catch {
            // 設定が次回に残らないだけ。今の操作は続行する。
          }
        },
        removeItem: (k) => {
          try {
            localStorage.removeItem(k);
          } catch {
            // 同上。
          }
        },
      })),
      // 残すのは再利用できる設定だけ。sources / 結果 / サムネは保存しない。
      partialize: (s) => ({ form: rememberedForm(s.form) }),
      // **既定の merge は浅い**ので、これが無いと `form` ごと差し替わり、
      // 保存していない width / height / overwrite が **undefined になって画面が壊れる**。
      merge: (persisted, current) => ({
        ...current,
        form: {
          ...current.form,
          ...sanitizeStoredForm((persisted as { form?: unknown } | undefined)?.form),
        },
      }),
    },
  ),
);
