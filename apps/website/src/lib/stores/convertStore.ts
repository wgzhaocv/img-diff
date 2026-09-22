import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ConvertOptions } from "schema";
import { convertSource, type ConvertSource } from "@/lib/convert";
import {
  FIT_VALUES,
  GRAVITY_VALUES,
  mimeOf,
  cannotWriteReason,
  webpBlob,
  WRITABLE_FORMATS,
} from "@/lib/convertControls";
import type { ConvertResult, InfoResult } from "@/lib/hashTypes";
import {
  clampQuality,
  isBadDim,
  normalizeOutFormat,
  parseDim,
  parseHexRgb,
  passesThrough,
  plannedOutput,
} from "@/lib/convertPlan";
import { PoolAbortError, poolRef, type HashPool } from "@/lib/workerPool";
import { errText } from "@/lib/format";
import { browserLocalStorage, dedupedStorage } from "@/lib/persistStorage";
import { extOf } from "@/lib/imagePaths";
import { dedupeInFlight } from "@/lib/inflight";

// convert 画面の状態ストア（zustand）。scanStore と同じ作法:
// コンポーネント外に持つのでルート切替でも結果が残り、ワーカープールも暖まったまま使い回す。
//
// **扱うのは 1 枚だけ**（SPEC §5.4「実装状況」）。この画面には「実行」が無い ——
// プレビューが既に本物の変換結果なので、残るのはそれを保存することだけ。

// **1 本だけ。** この画面で同時に走る仕事は常に 1 つ（プレビューか原寸取得か、片方だけ）。
// 本数を増やすと、`warmEngine` が温めるのは 1 本なのに `idle.pop()` が別の冷たいワーカーへ
// 配ってしまい、先読みが無駄になる（wasm-vips の初期化を丸ごと払い直す）。
// scan とは**別の持ち手**にする（共有すると convert の中断が走行中の scan を巻き込む）。
const pool = poolRef(1);

/** UI が持つ生の入力（未確定の値を含む）。プレビュー時に `ConvertOptions` へ解決する。 */
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
  /**
   * 縦横比を保つ（片方を直すともう片方が追う）。**既定で入っている** ——
   * 片方だけ直して意図しない切り抜きになるのが既定、というのはおかしい。
   * 切り抜きたい人は外す（外したことは次に開いても残る）。
   */
  lockRatio: boolean;
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
  lockRatio: true,
};

/**
 * **次に開いたときも残す設定**と、その検証。
 *
 * 表を 1 つにする —— 残す鍵の一覧と、戻すときの検証を別々に書くと、
 * 欄を足したときに片方だけ古くなる（保存はされるのに黙って捨てられる、が起きる）。
 *
 * 寸法を入れていないのには理由がある: 画像に付随する値なので、毎回その画像の原寸から始める
 * （前回の 1280 が今回の画像にとって意味を持つとは限らない）。
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
  // 背景は自由入力（transparent / average / hex）。resolveOptions が弾くので、
  // ここでは「文字列で、UI が壊れない長さ」だけ見る。
  background: (v) => (typeof v === "string" && v.length <= 32 ? v : undefined),
  format: (v) =>
    typeof v === "string" && (v === "" || WRITABLE_FORMATS.includes(v)) ? v : undefined,
  quality: (v) => (typeof v === "number" ? clampQuality(v) : undefined),
  qualityTouched: (v) => (typeof v === "boolean" ? v : undefined),
  lockRatio: (v) => (typeof v === "boolean" ? v : undefined),
};

/** 記憶する部分だけの形。ここに欄を足すと `REMEMBERED` の検証も必須になる（型で強制される）。 */
export type RememberedForm = Omit<ConvertForm, "width" | "height">;

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

/** 入力の見た目の情報（サムネ・原寸・バイト数）。worker の `op:"info"` が一度に返す。 */
export type SourceInfo = {
  /** ~256px の webp。デコードできなかったときは無し。 */
  thumb?: Blob;
  /** 原寸（EXIF の向き適用後）。デコードできなかったときは 0。 */
  width: number;
  height: number;
  bytes: number;
};

/**
 * 選び直しの世代。**古い選択の結果が新しい選択へ紛れ込むのを防ぐ**。
 * 原寸の取得もプレビューもこの 1 本を見る（プレビューは同時に 1 本しか走らないので、
 * 「設定を変えたから古い結果を捨てる」用の別カウンタは要らない）。
 */
let sourcesGen = 0;
/**
 * プレビューは**常に 1 枚だけ**走らせる。走行中の要求は「最後の 1 回」だけ覚えておき、
 * 終わってからやり直す（スライダを掴んで動かしても、変換が積み上がらない）。
 * 画面に関係しないのでストア外に置く。
 */
let previewBusy = false;
let previewQueued = false;
/**
 * 原寸とサムネの取得（`op:"info"`）。**同じ世代の要求は 1 本にまとめる** ——
 * まとめないと、`renderPreview` の催促が走っている最中にもう一度掛かって、
 * 48MP の png を丸ごと二度デコードすることになる。
 *
 * **鍵は「何枚目の選択か」**（`sourcesGen`）。真偽値の旗では足りないのは、選び直しを跨ぐと
 * **古い取得の後始末が新しい取得の旗を降ろす**から —— 鍵で分ければその取り違えが起こらない。
 */
const fetchInfo = dedupeInFlight(
  (_pool: HashPool, _src: ConvertSource, gen: number) => String(gen),
  async (p: HashPool, src: ConvertSource) =>
    (await p.submit({ op: "info", path: src.path, blob: src.file }, [])) as InfoResult,
);
/**
 * エンジンの先起こし。**走っている間の再入を防ぐ**ので、画面が何度 mount しても
 * ダウンロードは 1 回で済む。
 */
let warming: Promise<void> | null = null;

/** プレビュー 1 枚ぶんの結果（実際に変換して得たもの。推定値ではない）。 */
export type PreviewResult = {
  path: string;
  /** 変換後のバイト列。ブラウザが描けない形式（jxl / tiff / ppm）でも数値は正しい。 */
  blob: Blob;
  /**
   * 出力の寸法。**素通しのときは `null`**（デコードしていないので此方は知らない）。
   * 素通しの出力は元のバイト列そのもので、寸法は原寸に等しい ⇒ 画面は `info` を読む。
   * ここに 0 を入れて「0 なら出さない」と各所で書くと、番兵が画面まで漏れる。
   */
  width: number | null;
  height: number | null;
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
  /** 変換する 1 枚。**この画面が扱うのは常に 1 枚だけ。** */
  source: ConvertSource | null;
  form: ConvertForm;
  /** 取得できた原寸とサムネ。サムネ生成の後に届く（＝選んだ直後は null）。 */
  info: SourceInfo | null;
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
  setForm: (patch: Partial<ConvertForm>) => void;
  /** 変換する 1 枚を差し替える（`null` で選び直しに戻る）。 */
  setSource: (source: ConvertSource | null) => void;
  /** 原寸とサムネを取る。**取れた時点で寸法欄に原寸を入れる。** */
  loadInfo: () => Promise<void>;
  /** 今の設定で**実際に 1 枚変換して**プレビューを作る（推定ではなく本物を見せる）。 */
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
  reset: () => void;
};

/**
 * **プレビューを作り直すべき入力**の同一性。これが変わらなければ結果は 1 バイトも変わらない。
 *
 * 原寸も含める —— 大きすぎるかどうかの判定は原寸に依るので、原寸が届いた時点で
 * 作り直さないと「保存の側は理由を出しているのに、絵の側は実際に走って落ちる」になる。
 */
export function previewKey(s: ConvertState): string {
  const path = s.source?.path ?? "";
  const resolved = resolveOptions(s.form);
  const dims = s.info ? `${s.info.width}x${s.info.height}` : "?";
  return "error" in resolved
    ? `invalid:${path}`
    : `${path}\n${dims}\n${JSON.stringify(resolved.options)}`;
}

/**
 * 2 つの `previewKey` が**同じ設定**を指しているか（原寸の区画だけが違うか）。
 * 鍵は `path \n 原寸 \n 設定` の 3 区画なので、最後だけを見る。
 */
function sameOptions(a: string, b: string): boolean {
  const at = a.indexOf("\n", a.indexOf("\n") + 1);
  const bt = b.indexOf("\n", b.indexOf("\n") + 1);
  return at >= 0 && bt >= 0 && a.slice(at) === b.slice(bt);
}

/** フォームの生値を解決済みの `ConvertOptions` にする。`error` は入力エラー（理由つき）。 */
export function resolveOptions(form: ConvertForm): { options: ConvertOptions } | { error: string } {
  // 読み取りの規則は convertPlan（parseDim）が正本。画面の表示判定と同じ物を使う。
  if (isBadDim(form.width) || isBadDim(form.height)) {
    return { error: "幅と高さは 1 以上の整数で指定してください。" };
  }
  const width = parseDim(form.width);
  const height = parseDim(form.height);
  const format = form.format.trim() === "" ? null : normalizeOutFormat(form.format);
  // **背景は生値のまま渡す。** 既定は出力形式で決まり、形式が「入力と同じ」のときは
  // 入力次第なので、解決はワーカー側（実際の出力形式が確定する場所）で行う。
  const raw = form.background.trim().toLowerCase();
  const background = raw === "" ? null : raw;
  // hex を指定したなら先に弾く。**使われるときだけ**見る —— 背景は contain の余白にしか
  // 使わないので、cover に切り替えた利用者が「もう見えない欄の打ち間違い」で止められるのはおかしい。
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

export const useConvertStore = create<ConvertState>()(
  persist(
    (set, get) => ({
      source: null,
      form: DEFAULT_FORM,
      info: null,
      preview: null,
      previewRendering: false,
      previewError: null,
      engine: "cold",

      /**
       * **画像を渡さずにワーカー 1 本だけ起こす。**
       *
       * 起こすのが 1 本なのは、実体ごとに 1GiB の線形メモリを予約する（DESIGN §7.1）ため。
       *
       * `pool.hold()` を取るのは、画面切替の `releaseIdlePools()` が
       * **温めている最中のプールを畳まない**ようにするため（キューは空なので暇に見える）。
       *
       * **毎回投げてよい。** 二度目が無駄にならないのは、ワーカー側の `getVips()` が
       * 実体を記憶しているから（既に温まっていれば往復 1 回で即返る）。ここで
       * 「`engine === "ready"` なら投げない」と早切りすると、画面を離れて戻ったときに
       * `releaseIdlePools()` がプールを畳んでいても温かいと言い続けてしまう。
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

      setSource: (source) => {
        sourcesGen += 1;
        previewQueued = false;
        // **寸法は毎回リセットする。** 選び直したら新しい画像の原寸から始める（記憶もしない）。
        set((s) => ({
          source,
          info: null,
          preview: null,
          previewRendering: false,
          previewError: null,
          form: { ...s.form, width: "", height: "" },
        }));
      },
      reset: () => get().setSource(null),

      /**
       * 原寸とサムネを取る（`op:"info"`）。**ハッシュも全分解能 RGBA も作らない。**
       *
       * **必ず答えを残す**（デコードできない画像はワーカーが原寸 0 で返し、ファイルが
       * 読めなければここで原寸 0 を書く）。`renderPreview` が原寸の到着を待てるのは
       * この約束の上に乗っている。
       */
      loadInfo: async () => {
        const src = get().source;
        if (!src || get().info) return;
        const gen = sourcesGen;
        const releaseHold = pool.hold();
        try {
          const res = await fetchInfo(pool.get(), src, gen);
          if (gen !== sourcesGen) return; // 選び直された後に返ってきた結果は捨てる
          set({
            info: {
              thumb: res.thumb ? webpBlob(res.thumb) : undefined,
              width: res.width,
              height: res.height,
              bytes: res.bytes,
            },
          });
        } catch {
          // サムネが無くても変換はできるので、失敗そのものは報せない。
          // ただし**答えは必ず残す** —— 何も書かずに終わるとプレビューがそこで止まる。
          if (gen === sourcesGen) set({ info: { width: 0, height: 0, bytes: 0 } });
        } finally {
          releaseHold();
        }
      },

      renderPreview: async () => {
        const state = get();
        // 走行中なら「もう一度やる」とだけ覚えて戻る（要求を溜め込まない）。
        if (previewBusy) {
          previewQueued = true;
          return;
        }
        const src = state.source;
        if (!src) return;
        const resolved = resolveOptions(state.form);
        // 入力が不正なときは黙って前の絵を残す（理由は欄の直下に出ている）。
        if ("error" in resolved) return;

        const srcFormat = extOf(src.path);
        const key = previewKey(state);
        // **同じ鍵に成功した答えが既に在るなら作り直さない。** `ConvertPreview` の effect は
        // mount でも走るので、これが無いと画面を往復するたびに変換 1 回ぶんを丸ごと払う。
        // **誤りの側（`previewError`）では飛ばさない** —— 中断（プール破棄）もそこに記録されるので、
        // 飛ばすと「中断しました」のまま二度と復帰しなくなる。
        // **原寸が届いて鍵が変わっただけなら、同じ絵を名札だけ付け替えて使い回す。**
        // 素通しの出力は原寸に依らない（元のバイト列そのもの）ので作り直す意味が無く、
        // 作り直すと **`Blob` の同一性が変わって `useObjectUrl` が URL を張り替える**
        // ＝ ブラウザが絵を捨てて再デコードする（4000×3000 で目に見えて瞬く）。
        const prev = state.preview;
        if (prev?.passedThrough && prev.path === src.path && sameOptions(prev.key, key)) {
          set({ preview: { ...prev, key } });
          return;
        }
        if (state.preview?.key === key) {
          // 成功した絵と古い理由が同じ鍵で同居し得る（catch は `preview` を消さない）。
          // 作り直さないと決めた以上、ここで理由の方を落とす。
          if (state.previewError?.key === key) set({ previewError: null });
          return;
        }
        // **原寸が届くまでは作らない。ただし素通しだけは例外。**
        // 待つ理由は、原寸が「大きすぎて書けない」判定（`cannotWriteReason`）の入力であり、
        // かつ `previewKey` の一部なので、知らないまま始めると捨てるために符号化することになるから。
        // **素通しはそのどちらにも当たらない** —— 出力は元のバイト列そのもので、符号化もしないので
        // 原寸に一切依存しない。寸法欄が空なら `planned` 無しでも正しく判定できる
        // （両方 null ＝ 計画は必ず noop）。ここで待たないぶん、
        // 「開いて何も変えずに保存」が原寸のデコードを待たなくなる。
        if (!state.info) {
          // **無くても催促は必ず出す。** 「変換前」の寸法とサムネに要るし、黙って戻るだけにすると
          // 取得が落ちた場合に鍵が二度と変わらず、プレビューも保存ボタンも永久に止まる。
          void get().loadInfo();
          if (!passesThrough(resolved.options, srcFormat)) return;
        }
        // **原寸から導いた計画は 1 回だけ作る。** 「止めるか」と「素通しするか」が同じ物を見ることで、
        // 二つの判断がズレようが無くなる（ズレていたのがこの直前までの姿）。
        const planned =
          state.info && state.info.width > 0
            ? plannedOutput(resolved.options, state.info)
            : undefined;
        // 書けない・大きすぎるなら試さずに理由を出す。
        const reason = cannotWriteReason(resolved.options, srcFormat, planned);
        if (reason) {
          set({ previewRendering: false, previewError: { key, message: reason } });
          return;
        }

        const gen = sourcesGen;
        previewBusy = true;
        const releaseHold = pool.hold();
        set({ previewRendering: true, previewError: null });
        try {
          const format = normalizeOutFormat(resolved.options.format ?? srcFormat);
          const out = await convertSource(
            src,
            resolved.options,
            () => pool.get(),
            mimeOf(format),
            planned,
          );
          if (gen !== sourcesGen) return; // 選び直された後に返ってきた結果は捨てる
          set({
            preview: {
              path: src.path,
              blob: out.blob,
              // 素通しは寸法を返さない（デコードしていない）。原寸と同じなので画面が `info` を読む。
              width: out.passedThrough ? null : out.width,
              height: out.passedThrough ? null : out.height,
              bytes: out.blob.size,
              format,
              passedThrough: out.passedThrough,
              key,
            },
          });
        } catch (e) {
          if (gen !== sourcesGen) return;
          // 中断（プール破棄）はプレビューの失敗ではないが、**鍵に対する答えは必ず書く** ——
          // 黙って戻ると成功でも失敗でもない宙ぶらりんになり、保存ボタンが押せないまま固まる。
          const message = e instanceof PoolAbortError ? "中断しました" : errText(e);
          set({ previewError: { key, message } });
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

      previewAsPng: async () => {
        const preview = get().preview;
        if (!preview) throw new Error("プレビューがまだありません");
        if (preview.format === "png") return preview.blob;
        // 見えている結果そのものを包み直す（元画像から作り直すと、設定次第で別物になり得る）。
        const res = (await pool.get().submit(
          {
            op: "convert",
            path: preview.path,
            blob: preview.blob,
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
          [],
        )) as ConvertResult;
        if (res.error != null || !res.out) {
          throw new Error(res.error ?? "png に変換できませんでした");
        }
        return new Blob([res.out], { type: mimeOf("png") });
      },
    }),
    {
      name: "imgdiff-convert",
      version: 1,
      // 保存できない環境でも**画面は動き続ける**こと、そして**同じ物を二度書かない**こと。
      // どちらも `dedupedStorage` が面倒を見る（理由はそちらの説明に書いてある）。
      storage: createJSONStorage(() => dedupedStorage(browserLocalStorage)),
      // 残すのは再利用できる設定だけ。入力 / 結果 / サムネは保存しない。
      partialize: (s) => ({ form: rememberedForm(s.form) }),
      // **既定の merge は浅い**ので、これが無いと `form` ごと差し替わり、
      // 保存していない width / height が **undefined になって画面が壊れる**。
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
