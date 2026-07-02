import { defineConfig } from "vite-plus";

export default defineConfig({
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
