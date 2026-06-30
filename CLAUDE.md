<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# img-diff 项目

重复/相似图片检测工具。**两个模式**:① 文件夹查重(数百~数千张里找重复/近似) ② 两张图直接对比(并排 + 像素 diff + SSIM)。web 和 CLI 都提供。

## 结构(polyglot 单仓)

- `apps/website/` — web(React + Vite + **wasm-vips**)。File System Access API(仅 Chromium)。部署到 Cloudflare 静态资源(无服务器,纯客户端)。因用 `SharedArrayBuffer`,需 COOP/COEP 头(`apps/website/public/_headers`)。
- `crates/cli/` — CLI(Rust + **原生 libvips**)。bin 名 `imgdiff`,子命令 `scan`(查重)/ `compare`(两图对比)。
- `packages/schema/` — web/CLI 共享契约。**`packages/schema/SPEC.md` 是正本**(dHash 规范、严格度、聚类、输出格式);Rust 侧用 serde 对齐,不共享代码只共享规范。
- bun workspace(`packages/* apps/* tools/*`)与 cargo workspace(`crates/*`)并存:JS 用 `vp`,Rust 用 `cargo`,互不干扰。
- `reference/` — czkawka / wasm-vips / imagededup 的 clone(学习用,已 gitignore,非产品代码)。

## 用 Rust + libvips 构建 CLI 的环境(重要)

libvips 已用 MSYS2 装好(与默认 GNU 工具链 `x86_64-pc-windows-gnu` 匹配)。**构建/运行前先设环境变量**:

```powershell
$env:PKG_CONFIG_PATH = "C:\msys64\mingw64\lib\pkgconfig"
$env:PATH = "C:\msys64\mingw64\bin;" + $env:PATH   # 构建期需 pkg-config.exe,运行期需 vips 的 DLL
cargo build -p imgdiff
```

HEIC/AVIF/JXL/PDF 暂不支持(需要时 `pacman -S mingw-w64-x86_64-libheif` 等补装)。

## 约定

- **代码的注释和字符串一律用日语**(和用户聊天用中文)。
- web 前端的 UI/视觉一律遵循 `apps/website/UI.md`(视觉正本);做前端时 skill `imgdiff-ui` 会自动加载并强制。主色 Teal、亮色默认、WCAG AAA、反"AI 生成页"风格。
- 别误把 `reference/` 用 `git add .` 提交进去(已 gitignore,通常无碍)。
