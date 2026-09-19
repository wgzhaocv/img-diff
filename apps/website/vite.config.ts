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
  // worker が実際に使う分だけ（workers/vips.ts の dynamicLibraries と**必ず一致させる**。
  // 片方だけ足すと実行時に 404 する）。jxl は convert（SPEC §5.4）の入出力で使う。
  const files = ["vips-es6.js", "vips.wasm", "vips-heif.wasm", "vips-resvg.wasm", "vips-jxl.wasm"];
  return {
    name: "copy-wasm-vips",
    async buildStart() {
      await mkdir(dstDir, { recursive: true });
      await Promise.all(files.map((f) => copyFile(join(libDir, f), join(dstDir, f))));
    },
  };
}

/**
 * dev サーバで `/vips/*` への `?import` 付き要求を素のパスへ戻す。
 *
 * 動的 import（`workers/vips.ts` の `/vips/vips-es6.js`）に対し、Vite の dev は解析のため
 * URL へ `?import` を付ける。ところが public ディレクトリを配る中間件はクエリ付きに一致せず、
 * SPA の index.html が返ってしまう ⇒ `Failed to fetch dynamically imported module` となり
 * **dev では scan / compare / convert の全部が動かない**（本番はクエリが付かないので無傷）。
 * ソース側の `@vite-ignore` 注釈は「解析するな」の指示であって、この URL 書き換えは止められない。
 */
function serveVipsInDev(): PluginOption {
  return {
    name: "serve-vips-in-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url?.startsWith("/vips/")) req.url = req.url.split("?")[0];
        next();
      });
    },
  };
}

// img-diff web フロント。React + Tailwind v4 + shadcn/ui + wasm（crates/wasm）+ wasm-vips。
// dev サーバでも COOP/COEP を付け cross-origin isolation を有効化する
// （SharedArrayBuffer が要る wasm-vips のため。本番は public/_headers で付与）。
export default defineConfig({
  plugins: [react(), tailwindcss(), copyWasmVips(), serveVipsInDev()],
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
