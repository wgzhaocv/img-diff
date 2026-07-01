import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// img-diff web フロント。React + Tailwind v4 + shadcn/ui + wasm（crates/wasm）+ wasm-vips。
// dev サーバでも COOP/COEP を付け cross-origin isolation を有効化する
// （SharedArrayBuffer が要る wasm-vips のため。本番は public/_headers で付与）。
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
});
