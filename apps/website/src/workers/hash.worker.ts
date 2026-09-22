/// <reference lib="webworker" />
import init, {
  compare_all,
  flatten_and_dhash,
  flatten_on_white,
  hamming_hex,
} from "@/wasm/imgdiff_wasm";
import wasmUrl from "@/wasm/imgdiff_wasm_bg.wasm?url";
import { convertBuffer, decodeCanonical, getVips, imageInfo } from "./vips";
import { extOf } from "@/lib/imagePaths";
import { errText } from "@/lib/format";
import type {
  ConvertResult,
  DecodeResult,
  HashResult,
  ImageRequest,
  InfoResult,
  PixelResult,
  ScoreResult,
  WarmResult,
  WorkerRequest,
  WorkerResponse,
} from "@/lib/hashTypes";

let wasmReady: Promise<unknown> | null = null;
function ensureWasm(): Promise<unknown> {
  // 単一オブジェクト形で渡す（位置引数は wasm-bindgen で deprecated 警告になる）。
  if (!wasmReady) wasmReady = init({ module_or_path: wasmUrl });
  return wasmReady;
}

async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// デコード + 白平坦化 & dHash の結果（成功 or 失敗）。hashOne / decodeOne はこれを op ごとに射影するだけ。
type Decoded =
  | {
      sha256: string;
      bytes: number;
      phash: string;
      width: number;
      height: number;
      rgba: Uint8Array<ArrayBuffer>;
      thumb?: Uint8Array<ArrayBuffer>;
    }
  | { sha256: string; bytes: number; error: string };

/// sha256（ファイルバイト）+ デコード（wasm-vips, SPEC §1 手順 1〜3）+ 白平坦化 & dHash（core, 手順 4〜8）。
/// sha256 はデコード前に先に取る（digest は buffer を detach しないので後続の decode も有効）。
///
/// **サムネを作るかは呼び手が決める。** scan（`hash`）は一覧に要るので作るが、
/// compare（`decode`）は原ファイルをそのまま表示するので要らない。要らないのに作ると、
/// 縮小と webp 符号化を丸ごと払ううえ、HEIC では `decodeCanonical` の早期 return も外れる
/// （12MP で約 146MB 余計に使う）。
async function decodeFull(req: ImageRequest, wantThumb: boolean): Promise<Decoded> {
  const sha256 = await sha256Hex(req.bytes);
  const bytes = req.bytes.byteLength;
  try {
    await ensureWasm();
    const { rgba, width, height, thumb } = await decodeCanonical(
      req.bytes,
      wantThumb,
      extOf(req.path),
    );
    const phash = flatten_and_dhash(rgba, width, height); // rgba は in-place 白平坦化される（＝返す RGBA）。
    return { sha256, bytes, phash, width, height, rgba, thumb };
  } catch (e) {
    return { sha256, bytes, error: errText(e) };
  }
}

/// 1 パス目（scan）: sha256 + dHash + サムネ。全分解能 RGBA は使わないので返さない（GC される）。
async function hashOne(req: ImageRequest): Promise<HashResult> {
  const d = await decodeFull(req, true);
  if ("error" in d) {
    return {
      op: "hash",
      path: req.path,
      sha256: d.sha256,
      phash: null,
      width: 0,
      height: 0,
      bytes: d.bytes,
      error: d.error,
    };
  }
  return {
    op: "hash",
    path: req.path,
    sha256: d.sha256,
    phash: d.phash,
    width: d.width,
    height: d.height,
    bytes: d.bytes,
    thumb: d.thumb,
  };
}

/// 2 パス目（dHash 衝突バケットのみ・SPEC §2.1）: 全分解能で再デコード → 白平坦化 → pixelSha256。
/// CLI の `rgba_sha256`（pipeline.rs）と同じ「白平坦化後 RGBA の SHA-256」。
async function pixelOne(req: ImageRequest): Promise<PixelResult> {
  try {
    await ensureWasm();
    const { rgba } = await decodeCanonical(req.bytes, false, extOf(req.path));
    flatten_on_white(rgba); // in-place 白平坦化（alpha=255）。
    const pixelSha256 = await sha256Hex(rgba);
    return { op: "pixel", path: req.path, pixelSha256 };
  } catch (e) {
    return {
      op: "pixel",
      path: req.path,
      pixelSha256: null,
      error: errText(e),
    };
  }
}

/// compare（2 枚比較）用: hashOne に加え、白平坦化後の全分解能 RGBA も返す（SPEC §3/§4）。
/// 呼び出し側は続けて `op:"score"` へ渡す。全分解能デコードなので shrink-on-load は使わない
/// （pixel 比較の正しさに全画素が要る）。**サムネは作らない**（compare は原ファイルを表示する）。
async function decodeOne(req: ImageRequest): Promise<DecodeResult> {
  const d = await decodeFull(req, false);
  if ("error" in d) {
    return {
      op: "decode",
      path: req.path,
      sha256: d.sha256,
      phash: null,
      width: 0,
      height: 0,
      bytes: d.bytes,
      error: d.error,
    };
  }
  return {
    op: "decode",
    path: req.path,
    sha256: d.sha256,
    phash: d.phash,
    width: d.width,
    height: d.height,
    bytes: d.bytes,
    rgba: d.rgba,
  };
}

/// compare の採点と差分（SPEC §3/§4）。**主線程ではなくここで走らせる**のが要点で、
/// 12MP 2 枚なら数秒ぶん画面が固まっていたのが固まらなくなる。
/// `compare_all` は `compare_scores` + `diff_highlight` と同じ答えを、束縛層の往復 1 回で返す
/// （12MP 1 組で約 240MB → 144MB）。
async function scoreOne(req: Extract<WorkerRequest, { op: "score" }>): Promise<ScoreResult> {
  const empty: ScoreResult = {
    op: "score",
    hammingDistance: null,
    pixelDiffRatio: null,
    ssim: null,
    psnr: null,
  };
  try {
    await ensureWasm();
    const hammingDistance =
      req.phashA && req.phashB ? (hamming_hex(req.phashA, req.phashB) ?? null) : null;
    // 寸法が違えば連続値は出さない（SPEC §3。「比較不能」と「比較して不一致」は別物）。
    if (!req.pixels) return { ...empty, hammingDistance };
    const { a, b, width, height, tolerance } = req.pixels;
    const all = compare_all(new Uint8Array(a), new Uint8Array(b), width, height, tolerance);
    try {
      return {
        op: "score",
        hammingDistance,
        pixelDiffRatio: all.pixel_diff_ratio,
        ssim: all.ssim,
        psnr: all.psnr,
        // wasm 線形メモリからコピー済みの新しい非共有 ArrayBuffer（そのまま transfer できる）。
        diff: all.take_diff() as Uint8Array<ArrayBuffer>,
      };
    } finally {
      all.free(); // wasm-bindgen のオブジェクトは明示解放（leak 防止）。
    }
  } catch (e) {
    return { ...empty, error: errText(e) };
  }
}

/// 1 枚を変換する（SPEC §5.4）。デコード経路（decodeFull）とは独立で、
/// vips のハンドルを保ったまま resize/embed して符号化する。
async function convertOne(req: Extract<WorkerRequest, { op: "convert" }>): Promise<ConvertResult> {
  try {
    // **読むのはここ。** 主線程では読まない（`hashTypes.ts` の `op:"convert"` の説明）。
    const r = await convertBuffer(await req.blob.arrayBuffer(), req.options, req.srcFormat);
    return {
      op: "convert",
      path: req.path,
      out: r.out,
      width: r.width,
      height: r.height,
      vipsVersion: r.vipsVersion,
      passedThrough: r.passedThrough ?? false,
    };
  } catch (e) {
    // 1 件の失敗で全体を止めない（SPEC §5.4）。他の op と同じくエラーは戻り値で返す。
    return {
      op: "convert",
      path: req.path,
      width: 0,
      height: 0,
      error: errText(e),
    };
  }
}

/**
 * 画像を渡さずに**準備だけ**する。wasm-vips（約 11.9MB）と imgdiff-wasm を起こすので、
 * 最初の 1 件がダウンロードとコンパイルを丸ごと背負わなくなる。
 *
 * **失敗しても投げない。** これは利用者が頼んだ仕事ではなく前倒しなので、
 * ここで報せる相手が居ない（本当の理由は実際に変換したときに同じ経路で出る）。
 */
async function warmOne(): Promise<WarmResult> {
  try {
    await Promise.all([getVips(), ensureWasm()]);
    return { op: "warm" };
  } catch (e) {
    return { op: "warm", error: errText(e) };
  }
}

/// 表示用の情報だけを返す（原寸 + サムネ）。ハッシュも全分解能 RGBA も作らない。
async function infoOne(req: Extract<WorkerRequest, { op: "info" }>): Promise<InfoResult> {
  const bytes = req.blob.size;
  try {
    const { width, height, thumb } = await imageInfo(await req.blob.arrayBuffer(), extOf(req.path));
    return { op: "info", path: req.path, width, height, bytes, thumb };
  } catch (e) {
    // 画素をデコードできない（web の HEVC な HEIC など）。呼び出し側は「読み込めません」と出す。
    return { op: "info", path: req.path, width: 0, height: 0, bytes, error: errText(e) };
  }
}

/// 非 SAB な独立バッファ（rgba / thumb / out）は transfer してコピーを避ける。
function transfersOf(res: WorkerResponse): Transferable[] {
  const t: Transferable[] = [];
  if (res.op === "hash" && res.thumb) t.push(res.thumb.buffer);
  if (res.op === "decode" && res.rgba) t.push(res.rgba.buffer);
  if (res.op === "score" && res.diff) t.push(res.diff.buffer);
  if (res.op === "info" && res.thumb) t.push(res.thumb.buffer);
  if (res.op === "convert" && res.out) t.push(res.out.buffer);
  return t;
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  // 未知の op を黙って hash として扱わない（増やしたのに配線し忘れたことに気づけるように）。
  const res =
    req.op === "warm"
      ? await warmOne()
      : req.op === "convert"
        ? await convertOne(req)
        : req.op === "info"
          ? await infoOne(req)
          : req.op === "pixel"
            ? await pixelOne(req)
            : req.op === "score"
              ? await scoreOne(req)
              : req.op === "decode"
                ? await decodeOne(req)
                : req.op === "hash"
                  ? await hashOne(req)
                  : ({
                      op: "hash",
                      path: (req as { path: string }).path,
                      sha256: "",
                      phash: null,
                      width: 0,
                      height: 0,
                      bytes: 0,
                      error: `未知の op: ${String((req as { op: string }).op)}`,
                    } satisfies HashResult);
  self.postMessage(res, transfersOf(res));
};
