import { defineConfig } from "vite-plus";
import type { PluginOption } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";

// wasm-vips のランタイム（Emscripten）は import.meta.url 基準で vips.wasm と
// pthread ワーカー（自分自身）を解決する。バンドルすると解決先がずれて壊れるため、
// node_modules から public/vips へ実ファイルとしてコピーし、worker からは絶対 URL
// （/vips/vips-es6.js）で動的 import + locateFile させる。public/vips は gitignore 済。
function copyWasmVips(): PluginOption {
  const require = createRequire(import.meta.url);
  // wasm-vips の exports は "./package.json" を公開しないので main（lib 配下）から lib を得る。
  const libDir = dirname(require.resolve("wasm-vips"));
  const dstDir = fileURLToPath(new URL("./public/vips", import.meta.url));
  // worker が実際に使う分だけ（dynamicLibraries は heif + resvg。jxl は CLI 非対応につき積まない）。
  const files = ["vips-es6.js", "vips.wasm", "vips-heif.wasm", "vips-resvg.wasm"];
  return {
    name: "copy-wasm-vips",
    async buildStart() {
      await mkdir(dstDir, { recursive: true });
      await Promise.all(files.map((f) => copyFile(join(libDir, f), join(dstDir, f))));
    },
  };
}

// img-diff web フロント。React + Tailwind v4 + shadcn/ui + wasm（crates/wasm）+ wasm-vips。
// dev サーバでも COOP/COEP を付け cross-origin isolation を有効化する
// （SharedArrayBuffer が要る wasm-vips のため。本番は public/_headers で付与）。
export default defineConfig({
  plugins: [react(), tailwindcss(), copyWasmVips()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  // vp preview（本番ビルドの確認）でも cross-origin isolation を有効化する。
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  worker: {
    format: "es",
  },
});
