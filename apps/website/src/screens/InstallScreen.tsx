import { Package, Terminal } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScreenHeader } from "@/components/ScreenHeader";

export function InstallScreen() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <ScreenHeader title="インストール">
        大量のフォルダをコマンドラインで一括処理したいとき。OS 別の導入スクリプトは近日掲載します。
      </ScreenHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <Terminal className="size-5 text-primary" />
            <CardTitle className="mt-2">CLI（imgdiff）</CardTitle>
            <CardDescription>ネイティブ libvips で高速に scan / compare / clean。</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              GitHub Releases の自己完結パッケージを取得。（導入コマンドは準備中）
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <Package className="size-5 text-primary" />
            <CardTitle className="mt-2">AI 手册（skill）</CardTitle>
            <CardDescription>AI エージェントから imgdiff を駆動する操作手册。</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md bg-secondary px-3 py-2 font-mono text-sm text-secondary-foreground">
              npx skills add github:wgzhaocv/img-diff
            </pre>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
