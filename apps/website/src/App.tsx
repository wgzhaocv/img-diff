import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { Logo } from "@/components/Logo";
import { ModeTabs } from "@/components/ModeTabs";
import { useHashView } from "@/lib/router";
import { useTheme } from "@/lib/theme";
import { ScanScreen } from "@/screens/ScanScreen";
import { CompareScreen } from "@/screens/CompareScreen";
import { InstallScreen } from "@/screens/InstallScreen";

export function App() {
  const { view, navigate } = useHashView();
  const { theme, toggle } = useTheme();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b bg-background">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <a
            href="#/scan"
            className="flex items-center gap-2 font-semibold tracking-tight text-foreground hover:no-underline"
          >
            <Logo className="size-6" />
            <span className="text-base">img-diff</span>
          </a>

          <ModeTabs view={view} onNavigate={navigate} className="ml-1 hidden sm:block" />

          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" asChild>
              <a
                href="#/install"
                aria-current={view === "install" ? "page" : undefined}
                className="aria-[current=page]:bg-secondary aria-[current=page]:text-foreground"
              >
                インストール
              </a>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggle}
              aria-label={theme === "dark" ? "亮色テーマに切替" : "暗色テーマに切替"}
            >
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
          </div>
        </div>

        {/* 狭い画面ではモード切替を 2 段目に。定義は ModeTabs に一本化。 */}
        <div className="mx-auto max-w-6xl px-4 pb-2 sm:hidden">
          <ModeTabs view={view} onNavigate={navigate} fullWidth />
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
        {view === "scan" && <ScanScreen />}
        {view === "compare" && <CompareScreen />}
        {view === "install" && <InstallScreen />}
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-5 text-sm text-muted-foreground sm:px-6">
          <span>すべてブラウザ内で処理。画像はどこにも送信されません。</span>
          <a
            href="https://github.com/wgzhaocv/img-diff"
            target="_blank"
            rel="noreferrer"
            className="text-primary-text hover:underline"
          >
            GitHub
          </a>
        </div>
      </footer>

      <Toaster />
    </div>
  );
}
