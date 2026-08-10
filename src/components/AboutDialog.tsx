import { useEffect, useState } from "react";
import { getName, getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "@/lib/i18n";
import type { UseUpdateCheck } from "@/hooks/useUpdateCheck";
import "./AboutDialog.css";

interface AppInfo {
  name: string;
  version: string;
  tauriVersion: string;
}

const RELEASES_URL = "https://github.com/wxul/pnfc-toolkit/releases/latest";

export function AboutDialog({
  onClose,
  updateCheck,
}: {
  onClose: () => void;
  /** Owned by `App` (via `useUpdateCheck`) rather than this dialog, so the check runs once at
   * app startup and its result is still there the next time this dialog is opened, instead of
   * re-running (and forgetting the previous result) on every mount. */
  updateCheck: UseUpdateCheck;
}) {
  const { t } = useI18n();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const { state: updateState, recheck, install, isPortable } = updateCheck;

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
          {updateState.phase === "checking" && (
            <p className="about-update-status">{t("about.checking")}</p>
          )}
          {updateState.phase === "upToDate" && (
            <>
              <p className="about-update-status">{t("about.upToDate")}</p>
              <button className="about-update-btn" onClick={recheck}>
                {t("about.recheckUpdate")}
              </button>
            </>
          )}
          {updateState.phase === "available" && isPortable && (
            <>
              <p className="about-update-status">
                {t("about.portableUpdateAvailable", { version: updateState.update.version })}
              </p>
              <button className="about-update-btn" onClick={() => openUrl(RELEASES_URL)}>
                {t("about.openReleasePage")}
              </button>
            </>
          )}
          {updateState.phase === "available" && !isPortable && (
            <>
              <p className="about-update-status">
                {t("about.updateAvailable", { version: updateState.update.version })}
              </p>
              <button className="about-update-btn" onClick={() => install(updateState.update)}>
                {t("about.installAndRestart")}
              </button>
            </>
          )}
          {updateState.phase === "installing" && (
            <p className="about-update-status">{t("about.downloading")}</p>
          )}
          {updateState.phase === "error" && (
            <>
              <p className="about-update-status about-update-error">{t("about.updateError")}</p>
              <button className="about-update-btn" onClick={recheck}>
                {t("about.recheckUpdate")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
