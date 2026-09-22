import { defineConfig } from "vite-plus";
import type { PluginOption } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { copyFile, mkdir } from "node:fs/promises";
import { ROUTES } from "./src/routes";
import { VIPS_RUNTIME_FILES } from "./src/workers/vipsLibs";
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
  // **正本は `src/workers/vipsLibs.ts`**（何も import しない束なので、ここから読める）。
  // 片方だけ足すと実行時に 404 する。jxl は convert（SPEC §5.4）の入出力で使う。
  const files = VIPS_RUNTIME_FILES;
  return {
    name: "copy-wasm-vips",
    async buildStart() {
      await mkdir(dstDir, { recursive: true });
      await Promise.all(files.map((f) => copyFile(join(libDir, f), join(dstDir, f))));
    },
  };
}

/**
 * libheif の wasm を public/libheif へ置く。**HEVC の HEIC 専用の補助デコーダ**で、
 * wasm-vips の libheif が HEVC を持たないぶんを補う（workers/heic.ts）。
 * グルー（91KB）は普通に bundle され、wasm（1.4MB）だけ実ファイルで配る
 * —— 埋め込み版（libheif-bundle.mjs）だと転送が gzip 0.48MB → 0.70MB に増える。
 */
function copyLibheif(): PluginOption {
  const require = createRequire(import.meta.url);
  const libDir = dirname(require.resolve("libheif-js/libheif-wasm/libheif.js"));
  const dstDir = fileURLToPath(new URL("./public/libheif", import.meta.url));
  return {
    name: "copy-libheif",
    async buildStart() {
      await mkdir(dstDir, { recursive: true });
      await copyFile(join(libDir, "libheif.wasm"), join(dstDir, "libheif.wasm"));
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

/**
 * 各ルートに `index.html` の複製を置く（静的ホスティングには SPA フォールバックが無い）。
 *
 * これが無いと `/convert` を直接開く・再読み込みするだけで**素の 404** になる。
 * `/` から辿ると client-side ルーティングで動いてしまうので、気づかないまま出荷しやすい。
 * 平台は `/convert` と `/convert/` を同じ＝そのディレクトリの `index.html` として配るので、
 * 複製を置けばクリーンな URL のまま直リンクと再読み込みが通る。
 */
function emitRouteFallbacks(): PluginOption {
  return {
    name: "emit-route-fallbacks",
    apply: "build",
    async closeBundle() {
      const dist = fileURLToPath(new URL("./dist", import.meta.url));
      await Promise.all(
        ROUTES.map(async (route) => {
          await mkdir(join(dist, route), { recursive: true });
          await copyFile(join(dist, "index.html"), join(dist, route, "index.html"));
        }),
      );
    },
  };
}

// img-diff web フロント。React + Tailwind v4 + shadcn/ui + wasm（crates/wasm）+ wasm-vips。
// dev サーバでも COOP/COEP を付け cross-origin isolation を有効化する
// （SharedArrayBuffer が要る wasm-vips のため。本番は public/_headers で付与）。
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    copyWasmVips(),
    copyLibheif(),
    serveVipsInDev(),
    emitRouteFallbacks(),
  ],
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
