/// <reference lib="webworker" />
import init, { flatten_and_dhash, flatten_on_white } from "@/wasm/imgdiff_wasm";
import wasmUrl from "@/wasm/imgdiff_wasm_bg.wasm?url";
import { convertBuffer, decodeCanonical } from "./vips";
import type {
  ConvertResult,
  DecodeResult,
  HashResult,
  PixelResult,
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
async function decodeFull(req: WorkerRequest): Promise<Decoded> {
  const sha256 = await sha256Hex(req.bytes);
  const bytes = req.bytes.byteLength;
  try {
    await ensureWasm();
    const { rgba, width, height, thumb } = await decodeCanonical(req.bytes, true);
    const phash = flatten_and_dhash(rgba, width, height); // rgba は in-place 白平坦化される（＝返す RGBA）。
    return { sha256, bytes, phash, width, height, rgba, thumb };
  } catch (e) {
    return { sha256, bytes, error: e instanceof Error ? e.message : String(e) };
  }
}

/// 1 パス目（scan）: sha256 + dHash + サムネ。全分解能 RGBA は使わないので返さない（GC される）。
async function hashOne(req: WorkerRequest): Promise<HashResult> {
  const d = await decodeFull(req);
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
async function pixelOne(req: WorkerRequest): Promise<PixelResult> {
  try {
    await ensureWasm();
    const { rgba } = await decodeCanonical(req.bytes);
    flatten_on_white(rgba); // in-place 白平坦化（alpha=255）。
    const pixelSha256 = await sha256Hex(rgba);
    return { op: "pixel", path: req.path, pixelSha256 };
  } catch (e) {
    return {
      op: "pixel",
      path: req.path,
      pixelSha256: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/// compare（2 枚比較）用: hashOne に加え、白平坦化後の全分解能 RGBA も返す（SPEC §3/§4）。
/// 呼び出し側が compare_scores / diff_highlight に使う。全分解能デコードなので shrink-on-load は使わない
/// （pixel 比較の正しさに全画素が要る）。
async function decodeOne(req: WorkerRequest): Promise<DecodeResult> {
  const d = await decodeFull(req);
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
    thumb: d.thumb,
  };
}

/// 1 枚を変換する（SPEC §5.4）。デコード経路（decodeFull）とは独立で、
/// vips のハンドルを保ったまま resize/embed して符号化する。
async function convertOne(req: Extract<WorkerRequest, { op: "convert" }>): Promise<ConvertResult> {
  try {
    const r = await convertBuffer(req.bytes, req.options, req.srcFormat);
    return {
      op: "convert",
      path: req.path,
      out: r.out,
      format: r.format,
      width: r.width,
      height: r.height,
    };
  } catch (e) {
    // 1 件の失敗で全体を止めない（SPEC §5.4）。他の op と同じくエラーは戻り値で返す。
    return {
      op: "convert",
      path: req.path,
      format: "",
      width: 0,
      height: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/// 非 SAB な独立バッファ（rgba / thumb / out）は transfer してコピーを避ける。
function transfersOf(res: WorkerResponse): Transferable[] {
  const t: Transferable[] = [];
  if (res.op === "hash" && res.thumb) t.push(res.thumb.buffer);
  if (res.op === "decode") {
    if (res.rgba) t.push(res.rgba.buffer);
    if (res.thumb) t.push(res.thumb.buffer);
  }
  if (res.op === "convert" && res.out) t.push(res.out.buffer);
  return t;
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  // 未知の op を黙って hash として扱わない（増やしたのに配線し忘れたことに気づけるように）。
  const res =
    req.op === "convert"
      ? await convertOne(req)
      : req.op === "pixel"
        ? await pixelOne(req)
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
