import { useState } from "react";
import { Download, Package, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScreenHeader } from "@/components/ScreenHeader";
import { CopyBlock } from "@/components/CopyBlock";

// インストーラ・リリースの実 URL（配布は Windows のみ・Mac/Linux は近日）。
const INSTALL_URL = "https://imgdiff.wgzhao.me/install.ps1";
const RELEASES_URL = "https://github.com/wgzhaocv/img-diff/releases/latest";

type OS = "windows" | "macos" | "linux";
const OS_TABS: { value: OS; label: string }[] = [
  { value: "windows", label: "Windows" },
  { value: "macos", label: "macOS" },
  { value: "linux", label: "Linux" },
];

// 実行環境から OS を推定して既定タブにする。判定不能は Windows（唯一の実配布）へ倒す。
// （モバイル UA は mac/linux 側に寄るが、配布は desktop のみなので実害はない。）
function detectOS(): OS {
  if (typeof navigator === "undefined") return "windows";
  const s = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (s.includes("mac")) return "macos";
  if (s.includes("linux") || s.includes("x11")) return "linux";
  return "windows";
}

// Mac/Linux はプレビルド未配布 → ソースからビルドを案内（Windows 以外で共通）。
function BuildFromSource() {
  return (
    <div className="space-y-3 pt-2">
      <p className="text-sm text-muted-foreground">
        プレビルドのバイナリ配布は近日対応。現在はソースからビルドしてください（要 libvips +
        libheif）。
      </p>
      <CopyBlock command="cargo install --git https://github.com/wgzhaocv/img-diff imgdiff" />
    </div>
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
              <CopyBlock label="PowerShell（推奨）" command={`irm ${INSTALL_URL} | iex`} />
              <CopyBlock
                label="コマンドプロンプト"
                command={`powershell -c "irm ${INSTALL_URL} | iex"`}
              />
              <p className="text-sm text-muted-foreground">
                PowerShell 5.1+ 対応。同梱 DLL で MSYS2
                などの別途導入は不要。再実行すると最新版へ更新されます。
              </p>
              <Button variant="outline" size="sm" asChild className="gap-1.5">
                <a href={RELEASES_URL} target="_blank" rel="noreferrer">
                  <Download className="size-4" />
                  手動で zip を取得（GitHub Releases）
                </a>
              </Button>
            </TabsContent>

            <TabsContent value="macos">
              <BuildFromSource />
            </TabsContent>
            <TabsContent value="linux">
              <BuildFromSource />
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
