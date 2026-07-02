/// <reference lib="webworker" />
import init, { flatten_and_dhash, flatten_on_white } from "@/wasm/imgdiff_wasm";
import wasmUrl from "@/wasm/imgdiff_wasm_bg.wasm?url";
import { decodeCanonical } from "./vips";
import type { HashResult, PixelResult, WorkerRequest } from "@/lib/hashTypes";

let wasmReady: Promise<unknown> | null = null;
function ensureWasm(): Promise<unknown> {
  if (!wasmReady) wasmReady = init(wasmUrl);
  return wasmReady;
}

async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/// 1 パス目: sha256（ファイルバイト）+ デコード（wasm-vips, SPEC §1 手順 1〜3）+ 白平坦化 & dHash（core, 手順 4〜8）。
async function hashOne(req: WorkerRequest): Promise<HashResult> {
  // sha256 はデコード前に先に取る（digest は buffer を detach しないので後続の decode も有効）。
  const sha256 = await sha256Hex(req.bytes);
  try {
    await ensureWasm();
    const { rgba, width, height, thumb } = await decodeCanonical(req.bytes, true);
    const phash = flatten_and_dhash(rgba, width, height); // rgba は in-place 平坦化される。
    return {
      op: "hash",
      path: req.path,
      sha256,
      phash,
      width,
      height,
      bytes: req.bytes.byteLength,
      thumb,
    };
  } catch (e) {
    return {
      op: "hash",
      path: req.path,
      sha256,
      phash: null,
      width: 0,
      height: 0,
      bytes: req.bytes.byteLength,
      error: e instanceof Error ? e.message : String(e),
    };
  }
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

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  const res = req.op === "pixel" ? await pixelOne(req) : await hashOne(req);
  // thumb（非 SAB・独立バッファ）は transfer してコピーを避ける。
  const transfer = res.op === "hash" && res.thumb ? [res.thumb.buffer] : [];
  self.postMessage(res, transfer);
};
