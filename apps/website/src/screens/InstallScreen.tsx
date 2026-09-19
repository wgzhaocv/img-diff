import { useState } from "react";
import { Download, Package, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScreenHeader } from "@/components/ScreenHeader";
import { CopyBlock } from "@/components/CopyBlock";

// インストーラ・リリースの実 URL。プレビルド配布は Windows と macOS(Apple Silicon)。Linux は未対応。
const INSTALL_PS1_URL = "https://imgdiff.wgzhao.me/install.ps1";
const INSTALL_SH_URL = "https://imgdiff.wgzhao.me/install.sh";
const RELEASES_URL = "https://github.com/wgzhaocv/img-diff/releases/latest";
// macOS 版は Windows 版より先行しているため pre-release（= `releases/latest` に出てこない）。
// タグを直接指す。**Windows 版が揃って正式リリースへ昇格したら RELEASES_URL に統一する。**
// tag が古いまま発版すると無言で古い版を案内するので、scripts/package-macos.sh が
// 「このファイルの tag == パッケージの版」を毎回検査して止める（public/install.sh も同様）。
const MACOS_RELEASE_URL = "https://github.com/wgzhaocv/img-diff/releases/tag/v0.1.5";

type OS = "windows" | "macos" | "linux";
const OS_TABS: { value: OS; label: string }[] = [
  { value: "windows", label: "Windows" },
  { value: "macos", label: "macOS" },
  { value: "linux", label: "Linux" },
];

// 実行環境から OS を推定して既定タブにする。判定不能は Windows（最も広く配布している方）へ倒す。
// （モバイル UA は mac/linux 側に寄るが、配布は desktop のみなので実害はない。）
function detectOS(): OS {
  if (typeof navigator === "undefined") return "windows";
  const s = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (s.includes("mac")) return "macos";
  if (s.includes("linux") || s.includes("x11")) return "linux";
  return "windows";
}

// ソースからのビルド案内。Linux（プレビルド未配布）と、macOS の対象外環境
// （Intel Mac・macOS 25 以前）で共有する。理由書きは呼び出し側が JSX で渡す。
function BuildFromSource({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{children}</p>
      <CopyBlock command="cargo install --git https://github.com/wgzhaocv/img-diff imgdiff" />
    </div>
  );
}

// GitHub Releases への導線（Windows / macOS タブで共用。違うのは行き先だけ）。
function ReleaseZipLink({ href }: { href: string }) {
  return (
    <Button variant="outline" size="sm" asChild className="gap-1.5">
      <a href={href} target="_blank" rel="noreferrer">
        <Download className="size-4" />
        手動で zip を取得（GitHub Releases）
      </a>
    </Button>
  );
}

export function InstallScreen() {
  const [os, setOs] = useState<OS>(detectOS);

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <ScreenHeader title="インストール">
        大量のフォルダを CLI で一括処理したいとき。ブラウザ版と同じ判定を、ネイティブ libvips
        で高速に scan / compare / clean できます。
      </ScreenHeader>

      <Card>
        <CardHeader>
          <Terminal className="size-5 text-primary" />
          <CardTitle className="mt-2">CLI（imgdiff）</CardTitle>
          <CardDescription>OS を選んで導入コマンドをコピー。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs value={os} onValueChange={(v) => setOs(v as OS)}>
            <TabsList>
              {OS_TABS.map(({ value, label }) => (
                <TabsTrigger key={value} value={value}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="windows" className="space-y-4 pt-2">
              <CopyBlock label="PowerShell（推奨）" command={`irm ${INSTALL_PS1_URL} | iex`} />
              <CopyBlock
                label="コマンドプロンプト"
                command={`powershell -c "irm ${INSTALL_PS1_URL} | iex"`}
              />
              <p className="text-sm text-muted-foreground">
                PowerShell 5.1+ 対応。同梱 DLL で MSYS2
                などの別途導入は不要。再実行すると最新版へ更新されます。
              </p>
              <ReleaseZipLink href={RELEASES_URL} />
            </TabsContent>

            <TabsContent value="macos" className="space-y-4 pt-2">
              <CopyBlock
                label="ターミナル（推奨）"
                command={`curl -fsSL ${INSTALL_SH_URL} | bash`}
              />
              <p className="text-sm text-muted-foreground">
                同梱 dylib で Homebrew の libvips は不要（HEIC / AVIF / JXL も読めます）。
                再実行すると最新版へ更新されます。
                <br />
                対象は{" "}
                <strong className="font-medium text-foreground">
                  Apple Silicon・macOS 26 以降
                </strong>
                。それ以外では下のソースビルドを使ってください。
              </p>
              <div className="space-y-1.5">
                <ReleaseZipLink href={MACOS_RELEASE_URL} />
                <p className="text-sm text-muted-foreground">
                  ブラウザで落とした zip には隔離属性が付くため、展開後に{" "}
                  <code className="font-mono text-foreground">
                    xattr -dr com.apple.quarantine &lt;展開先&gt;
                  </code>{" "}
                  が要ります。
                </p>
              </div>
              <BuildFromSource>
                Intel Mac / macOS 25 以前はソースからビルドしてください（先に{" "}
                <code className="font-mono text-foreground">brew install vips libheif</code>）。
              </BuildFromSource>
            </TabsContent>
            <TabsContent value="linux" className="pt-2">
              <BuildFromSource>
                Linux のプレビルド配布は未対応。ソースからビルドしてください（要 libvips +
                libheif）。
              </BuildFromSource>
            </TabsContent>
          </Tabs>

          <p className="text-sm text-muted-foreground">
            導入後の確認: <code className="font-mono text-foreground">imgdiff --help</code> ／ AI
            手順書は <code className="font-mono text-foreground">imgdiff skill</code>。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <Package className="size-5 text-primary" />
          <CardTitle className="mt-2">AI 手順書（skill）</CardTitle>
          <CardDescription>AI エージェントから imgdiff を駆動する操作ガイド。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CopyBlock command="npx skills add github:wgzhaocv/img-diff" />
          <p className="text-sm text-muted-foreground">
            skills.sh 生態で導入し、更新は{" "}
            <code className="font-mono text-foreground">npx skills update</code>。Claude Code などの
            エージェントが imgdiff の scan / compare / clean を安全に呼べるようになります。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
