// アプリの全ルート。**ここが唯一の正本。**
//
// 静的ホスティング（Polaris）には SPA のフォールバックが無く、`/convert` のような
// 「ファイルとして存在しないパス」は素の 404 になる（`/` から辿ると client-side ルーティングで
// 動くので気づきにくい）。そこでビルド後に各ルートへ `index.html` の複製を置く
// （平台は `/convert` と `/convert/` を同じ＝そのディレクトリの index として配る）。
//
// その生成は `vite.config.ts` がこの配列を読んで行う。**ルートを足したらここに足すだけ**で、
// ルーティングと配信の両方が揃う（片方だけ足して静かに 404 になるのを防ぐ）。
// `og` は OG 画像を作り直すためだけの画面（公開ナビからは辿れない）。ここに置くのは
// 配信側のフォールバックを揃えるため —— 本番で直接開いても 404 にしない。
export const ROUTES = ["scan", "compare", "convert", "install", "og"] as const;

export type RoutePath = (typeof ROUTES)[number];
