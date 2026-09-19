import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // `vp test` はリポジトリ根の設定で走るので、apps/website の `@/` 別名をここにも持たせる
  // （持たせないと apps/website/tests/* から src を import した瞬間に解決できない）。
  // apps/website/vite.config.ts 側の別名とは別物なので、片方だけ変えないこと。
  resolve: {
    alias: { "@": fileURLToPath(new URL("./apps/website/src", import.meta.url)) },
  },
  staged: {
    "*": "vp check --fix",
  },
  // 生成物（wasm-pack 出力）は整形・lint しない（pristine を保ち再生成 churn を避ける）。
  fmt: {
    ignorePatterns: ["**/src/wasm/**"],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ["**/src/wasm/**"],
  },
  run: {
    cache: true,
  },
});
