/// <reference lib="webworker" />
import init, { flatten_and_dhash } from "@/wasm/imgdiff_wasm";
import wasmUrl from "@/wasm/imgdiff_wasm_bg.wasm?url";
import { decodeCanonical } from "./vips";
import type { HashRequest, HashResponse } from "@/lib/hashTypes";

let wasmReady: Promise<unknown> | null = null;
function ensureWasm(): Promise<unknown> {
  if (!wasmReady) wasmReady = init(wasmUrl);
  return wasmReady;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/// 1 枚: sha256（ファイルバイト）+ デコード（wasm-vips, SPEC §1 手順 1〜3）+ 白平坦化 & dHash（core, 手順 4〜8）。
async function hashOne(req: HashRequest): Promise<HashResponse> {
  // sha256 はデコード前に先に取る（digest は buffer を detach しないので後続の decode も有効）。
  const sha256 = await sha256Hex(req.bytes);
  try {
    await ensureWasm();
    const { rgba, width, height } = await decodeCanonical(req.bytes);
    const phash = flatten_and_dhash(rgba, width, height); // rgba は in-place 平坦化される。
    return {
      id: req.id,
      path: req.path,
      sha256,
      phash,
      width,
      height,
      bytes: req.bytes.byteLength,
    };
  } catch (e) {
    return {
      id: req.id,
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

self.onmessage = async (ev: MessageEvent<HashRequest>) => {
  self.postMessage(await hashOne(ev.data));
};
