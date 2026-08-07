import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logFrontend } from "@/lib/devLog";
import { useI18n } from "@/lib/i18n";
import {
  isValidPasswordHex,
  randomPasswordHex,
  type CardInfo,
  type PasswordProtection,
} from "@/lib/pn532Types";

type Mode = "idle" | "form" | "clear";

const inputClass =
  "rounded-md border bg-background px-3 py-1.5 text-sm font-mono disabled:opacity-50";

/**
 * Write-password protection management for NTAG/Ultralight (set/change/remove). Only
 * implements the "protect writes, not reads" mode (ACCESS.PROT is always written as 0), with
 * the range fixed to start at page4 (the first user-data page) and cover all writable content
 * — the specific AUTH0 page number isn't exposed for the user to choose, to avoid an average
 * user ending up with some bizarre "half protected" configuration.
 */
export function NtagPasswordProtection({
  card,
  passwordProtection,
  chipRecognized,
  setPollingPaused,
  onChanged,
}: {
  card: CardInfo;
  passwordProtection?: PasswordProtection;
  /** Without an identified model there's no way to locate the config page, so this kind of
   * card doesn't offer a way to set protection — just explain why. */
  chipRecognized: boolean;
  setPollingPaused: (paused: boolean) => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const enabled = !!passwordProtection?.enabled;
  const [mode, setMode] = useState<Mode>("idle");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetForm() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setAcknowledged(false);
    setError(null);
  }

  function openForm() {
    resetForm();
    setMode("form");
  }

  function openClear() {
    resetForm();
    setMode("clear");
  }

  function cancel() {
    resetForm();
    setMode("idle");
  }

  const formValid =
    isValidPasswordHex(newPassword) &&
    newPassword.toUpperCase() === confirmPassword.toUpperCase() &&
    acknowledged &&
    (!enabled || isValidPasswordHex(currentPassword));

  async function submitForm() {
    if (!formValid) return;
    setBusy(true);
    setPollingPaused(true);
    setError(null);
    try {
      await invoke("set_ntag_password", {
        expectedUid: card.uid,
        currentPassword: enabled ? currentPassword : null,
        newPassword,
      });
      logFrontend("info", `${card.uid} password protection ${enabled ? "changed" : "set"}`);
      resetForm();
      setMode("idle");
      onChanged();
    } catch (e) {
      setError(String(e));
      logFrontend("error", `Failed to set password protection: ${String(e)}`);
    } finally {
      setBusy(false);
      setPollingPaused(false);
    }
  }

  async function submitClear() {
    if (!isValidPasswordHex(currentPassword)) return;
    setBusy(true);
    setPollingPaused(true);
    setError(null);
    try {
      await invoke("clear_ntag_password", {
        expectedUid: card.uid,
        currentPassword,
      });
      logFrontend("info", `${card.uid} password protection removed`);
      resetForm();
      setMode("idle");
      onChanged();
    } catch (e) {
      setError(String(e));
      logFrontend("error", `Failed to remove password protection: ${String(e)}`);
    } finally {
      setBusy(false);
      setPollingPaused(false);
    }
  }

  if (!chipRecognized) {
    return (
      <p className="text-center text-xs text-muted-foreground">
        {t("pwdProtect.notRecognized")}
      </p>
    );
  }

  if (mode === "idle") {
    return (
      <div className="flex justify-center gap-2">
        {enabled ? (
          <>
            <button
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
              onClick={openForm}
            >
              {t("pwdProtect.changePassword")}
            </button>
            <button
              className="rounded-md border px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
              onClick={openClear}
            >
              {t("pwdProtect.removeProtection")}
            </button>
          </>
        ) : (
          <button
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            onClick={openForm}
          >
            {t("pwdProtect.setProtection")}
          </button>
        )}
      </div>
    );
  }

  if (mode === "clear") {
    return (
      <div className="flex flex-col gap-2 rounded-md border p-3">
        <p className="text-sm font-medium">{t("pwdProtect.removeTitle")}</p>
        <input
          className={inputClass}
          placeholder={t("pwdProtect.currentPasswordPlaceholder")}
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          disabled={busy}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            onClick={cancel}
            disabled={busy}
          >
            {t("common.cancel")}
          </button>
          <button
            className="rounded-md border bg-secondary px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
            onClick={submitClear}
            disabled={busy || !isValidPasswordHex(currentPassword)}
          >
            {busy ? t("common.processing") : t("pwdProtect.confirmRemove")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <p className="text-sm font-medium">{enabled ? t("pwdProtect.changePassword") : t("pwdProtect.setProtection")}</p>
      <p className="text-xs text-muted-foreground">
        {t("pwdProtect.protectionExplanation")}
      </p>
      {enabled && (
        <input
          className={inputClass}
          placeholder={t("pwdProtect.currentPasswordPlaceholder")}
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          disabled={busy}
        />
      )}
      <div className="flex gap-2">
        <input
          className={`${inputClass} flex-1`}
          placeholder={t("pwdProtect.newPasswordPlaceholder")}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          disabled={busy}
        />
        <button
          className="rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
          onClick={() => {
            const pwd = randomPasswordHex();
            setNewPassword(pwd);
            setConfirmPassword(pwd);
          }}
          disabled={busy}
        >
          {t("pwdProtect.generateRandom")}
        </button>
      </div>
      <input
        className={inputClass}
        placeholder={t("pwdProtect.confirmNewPasswordPlaceholder")}
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        disabled={busy}
      />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          disabled={busy}
        />
        {t("pwdProtect.acknowledgeCheckbox")}
      </label>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <button
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          onClick={cancel}
          disabled={busy}
        >
          {t("common.cancel")}
        </button>
        <button
          className="rounded-md border bg-secondary px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
          onClick={submitForm}
          disabled={busy || !formValid}
        >
          {busy ? t("common.processing") : enabled ? t("pwdProtect.confirmChange") : t("pwdProtect.confirmSet")}
        </button>
      </div>
    </div>
  );
}
