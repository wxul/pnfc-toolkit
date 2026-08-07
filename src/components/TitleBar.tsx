import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Languages, Minus, Square, X } from "lucide-react";
import { AppMenubar } from "./AppMenubar";
import { useI18n } from "@/lib/i18n";

const appWindow = getCurrentWindow();

export function TitleBar({
  onOpenDevPanel,
  onOpenAbout,
}: {
  onOpenDevPanel: () => void;
  onOpenAbout: () => void;
}) {
  const [isMaximized, setIsMaximized] = useState(false);
  const { locale, setLocale, t } = useI18n();

  useEffect(() => {
    appWindow.isMaximized().then(setIsMaximized);
    const unlisten = appWindow.onResized(() => {
      appWindow.isMaximized().then(setIsMaximized);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div
      className="flex h-9 shrink-0 select-none items-stretch border-b bg-background"
      data-tauri-drag-region
      onDoubleClick={() => appWindow.toggleMaximize()}
    >
      <div className="flex items-center gap-1.5 pr-2 pl-3" data-tauri-drag-region>
        <img src="/logo.svg" alt="" className="h-6 w-6" />
        <span className="text-xs font-medium text-muted-foreground">{t("titleBar.appName")}</span>
      </div>

      <AppMenubar onOpenDevPanel={onOpenDevPanel} onOpenAbout={onOpenAbout} />

      <div className="flex-1" data-tauri-drag-region />

      <div className="flex items-stretch">
        <button
          className="flex items-center gap-1 px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
          aria-label={locale === "zh" ? t("titleBar.switchToEn") : t("titleBar.switchToZh")}
          title={locale === "zh" ? t("titleBar.switchToEn") : t("titleBar.switchToZh")}
        >
          <Languages className="h-3.5 w-3.5" />
          {locale === "zh" ? "中文" : "EN"}
        </button>
        <button
          className="flex w-11 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => appWindow.minimize()}
          aria-label={t("titleBar.minimize")}
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          className="flex w-11 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => appWindow.toggleMaximize()}
          aria-label={isMaximized ? t("titleBar.restore") : t("titleBar.maximize")}
        >
          {isMaximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
        </button>
        <button
          className="flex w-11 items-center justify-center text-muted-foreground hover:bg-destructive hover:text-white"
          onClick={() => appWindow.close()}
          aria-label={t("titleBar.close")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
