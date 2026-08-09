import { useEffect, useState } from "react";
import { getName, getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useI18n } from "@/lib/i18n";
import "./AboutDialog.css";

interface AppInfo {
  name: string;
  version: string;
  tauriVersion: string;
}

type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "upToDate" }
  | { phase: "available"; update: Update }
  | { phase: "installing" }
  | { phase: "error" };

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState>({ phase: "idle" });

  useEffect(() => {
    Promise.all([getName(), getVersion(), getTauriVersion()]).then(
      ([name, version, tauriVersion]) => setInfo({ name, version, tauriVersion }),
    );

    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  async function handleCheckUpdate() {
    setUpdateState({ phase: "checking" });
    try {
      const update = await check();
      setUpdateState(update ? { phase: "available", update } : { phase: "upToDate" });
    } catch {
      setUpdateState({ phase: "error" });
    }
  }

  async function handleInstallUpdate(update: Update) {
    setUpdateState({ phase: "installing" });
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch {
      setUpdateState({ phase: "error" });
    }
  }

  return (
    <div className="about-backdrop" onClick={onClose}>
      <div className="about-dialog" role="dialog" aria-label="About" onClick={(e) => e.stopPropagation()}>
        <button className="about-close" onClick={onClose} aria-label={t("about.close")}>
          ✕
        </button>
        <div className="about-icon">📡</div>
        <h2>{info?.name ?? "pnfc-toolkit"}</h2>
        <p className="about-desc">{t("about.description")}</p>
        <dl className="about-meta">
          <dt>{t("about.version")}</dt>
          <dd>{info?.version ?? "-"}</dd>
          <dt>Tauri</dt>
          <dd>{info?.tauriVersion ?? "-"}</dd>
        </dl>

        <div className="about-update">
          {updateState.phase === "idle" && (
            <button className="about-update-btn" onClick={handleCheckUpdate}>
              {t("about.checkUpdate")}
            </button>
          )}
          {updateState.phase === "checking" && (
            <p className="about-update-status">{t("about.checking")}</p>
          )}
          {updateState.phase === "upToDate" && (
            <p className="about-update-status">{t("about.upToDate")}</p>
          )}
          {updateState.phase === "available" && (
            <>
              <p className="about-update-status">
                {t("about.updateAvailable", { version: updateState.update.version })}
              </p>
              <button
                className="about-update-btn"
                onClick={() => handleInstallUpdate(updateState.update)}
              >
                {t("about.installAndRestart")}
              </button>
            </>
          )}
          {updateState.phase === "installing" && (
            <p className="about-update-status">{t("about.downloading")}</p>
          )}
          {updateState.phase === "error" && (
            <p className="about-update-status about-update-error">{t("about.updateError")}</p>
          )}
        </div>
      </div>
    </div>
  );
}
