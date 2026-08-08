import { useEffect, useState } from "react";
import { getName, getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { useI18n } from "@/lib/i18n";
import "./AboutDialog.css";

interface AppInfo {
  name: string;
  version: string;
  tauriVersion: string;
}

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<AppInfo | null>(null);

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
      </div>
    </div>
  );
}
