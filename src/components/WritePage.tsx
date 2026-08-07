import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logFrontend } from "@/lib/devLog";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { isValidPasswordHex, type CardInfo, type PasswordProtection } from "@/lib/pn532Types";
import { buildVCard, isVCardFilled, type VCardFields } from "@/lib/vcard";

type RecordKind = "url" | "text" | "tel" | "sms" | "mailto" | "geo" | "vcard" | "wifi";

interface RecordDraft {
  id: number;
  kind: RecordKind;
  fields: Record<string, string>;
}

const KIND_LABEL_KEYS: Record<RecordKind, TranslationKey> = {
  url: "write.kindUrl",
  text: "write.kindText",
  tel: "write.kindTel",
  sms: "write.kindSms",
  mailto: "write.kindMailto",
  geo: "write.kindGeo",
  vcard: "write.kindVcard",
  wifi: "write.kindWifi",
};

function buildContent(kind: RecordKind, fields: Record<string, string>): string {
  switch (kind) {
    case "geo":
      return `${fields.lat ?? ""},${fields.lng ?? ""}`;
    case "vcard":
      return buildVCard(fields as VCardFields);
    case "wifi":
      return `${fields.ssid ?? ""}\n${fields.password ?? ""}`;
    default:
      return fields.value ?? "";
  }
}

function isDraftFilled(kind: RecordKind, fields: Record<string, string>): boolean {
  switch (kind) {
    case "geo":
      return !!fields.lat?.trim() && !!fields.lng?.trim();
    case "vcard":
      return isVCardFilled(fields as VCardFields);
    case "wifi":
      return !!fields.ssid?.trim();
    default:
      return !!fields.value?.trim();
  }
}

function RecordFields({
  draft,
  disabled,
  onChange,
}: {
  draft: RecordDraft;
  disabled: boolean;
  onChange: (field: string, value: string) => void;
}) {
  const { t } = useI18n();
  const inputClass =
    "rounded-md border bg-background px-3 py-1.5 text-sm disabled:opacity-50";

  switch (draft.kind) {
    case "geo":
      return (
        <div className="flex gap-2">
          <input
            className={`${inputClass} flex-1`}
            placeholder={t("write.latPlaceholder")}
            value={draft.fields.lat ?? ""}
            onChange={(e) => onChange("lat", e.target.value)}
            disabled={disabled}
          />
          <input
            className={`${inputClass} flex-1`}
            placeholder={t("write.lngPlaceholder")}
            value={draft.fields.lng ?? ""}
            onChange={(e) => onChange("lng", e.target.value)}
            disabled={disabled}
          />
        </div>
      );
    case "vcard": {
      const f = (key: string, placeholder: string, span = false) => (
        <input
          key={key}
          className={`${inputClass} ${span ? "col-span-2" : ""}`}
          placeholder={placeholder}
          value={draft.fields[key] ?? ""}
          onChange={(e) => onChange(key, e.target.value)}
          disabled={disabled}
        />
      );
      return (
        <div className="grid grid-cols-2 gap-2">
          {f("familyName", t("write.vcardFamilyName"))}
          {f("givenName", t("write.vcardGivenName"))}
          {f("nickname", t("write.vcardNickname"))}
          {f("org", t("write.vcardOrg"))}
          {f("title", t("write.vcardTitle"))}
          {f("role", t("write.vcardRole"))}
          {f("phone", t("write.vcardPhone"))}
          {f("email", t("write.vcardEmail"))}
          {f("url", t("write.vcardUrl"), true)}
          {f("adrStreet", t("write.vcardAdrStreet"), true)}
          {f("adrCity", t("write.vcardAdrCity"))}
          {f("adrState", t("write.vcardAdrState"))}
          {f("adrPostalCode", t("write.vcardAdrPostalCode"))}
          {f("adrCountry", t("write.vcardAdrCountry"))}
          {f("label", t("write.vcardLabel"), true)}
          {f("note", t("write.vcardNote"), true)}
          {f("photo", t("write.vcardPhoto"), true)}
          {f("logo", t("write.vcardLogo"), true)}
          {f("bday", t("write.vcardBday"))}
          {f("anniversary", t("write.vcardAnniversary"))}
          {f("categories", t("write.vcardCategories"), true)}
        </div>
      );
    }
    case "wifi":
      return (
        <div className="flex gap-2">
          <input
            className={`${inputClass} flex-1`}
            placeholder={t("write.wifiSsid")}
            value={draft.fields.ssid ?? ""}
            onChange={(e) => onChange("ssid", e.target.value)}
            disabled={disabled}
          />
          <input
            className={`${inputClass} flex-1`}
            placeholder={t("write.wifiPassword")}
            value={draft.fields.password ?? ""}
            onChange={(e) => onChange("password", e.target.value)}
            disabled={disabled}
          />
        </div>
      );
    default: {
      const placeholder =
        draft.kind === "url"
          ? t("write.urlPlaceholder")
          : draft.kind === "tel"
            ? t("write.telPlaceholder")
            : draft.kind === "sms"
              ? t("write.telPlaceholder")
              : draft.kind === "mailto"
                ? "someone@example.com"
                : t("write.textPlaceholder");
      return (
        <input
          className={inputClass}
          placeholder={placeholder}
          value={draft.fields.value ?? ""}
          onChange={(e) => onChange("value", e.target.value)}
          disabled={disabled}
        />
      );
    }
  }
}

let nextDraftId = 1;

export function WritePage({
  connectedPort,
  card,
  setPollingPaused,
}: {
  connectedPort: string | null;
  card: CardInfo | null;
  /** Checking the password-protection status takes one antenna exchange; background polling
   * is paused during that so the two don't compete. */
  setPollingPaused: (paused: boolean) => void;
}) {
  const { t } = useI18n();
  const [drafts, setDrafts] = useState<RecordDraft[]>([
    { id: nextDraftId++, kind: "url", fields: {} },
  ]);
  const [writing, setWriting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [protection, setProtection] = useState<PasswordProtection | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [writePassword, setWritePassword] = useState("");
  const cancelledRef = useRef(false);

  // As soon as the card changes (UID changed), recheck whether this card needs a password to
  // write — using the lightweight single-page query (not a full card dump), fast enough to use
  // right before writing.
  useEffect(() => {
    let cancelled = false;
    setProtection(null);
    if (card && card.sel_res === "00") {
      queueMicrotask(() => {
        if (!cancelled) checkProtection();
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.uid]);

  async function checkProtection() {
    setPollingPaused(true);
    try {
      const p = await invoke<PasswordProtection | null>("read_ntag_password_status");
      setProtection(p);
    } catch (e) {
      logFrontend("error", `Failed to read password protection status: ${String(e)}`);
    } finally {
      setPollingPaused(false);
    }
  }

  function addDraft() {
    setDrafts((prev) => [...prev, { id: nextDraftId++, kind: "url", fields: {} }]);
  }

  function removeDraft(id: number) {
    setDrafts((prev) => prev.filter((d) => d.id !== id));
  }

  function setKind(id: number, kind: RecordKind) {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { id, kind, fields: {} } : d)));
  }

  function setField(id: number, field: string, value: string) {
    setDrafts((prev) =>
      prev.map((d) => (d.id === id ? { ...d, fields: { ...d.fields, [field]: value } } : d)),
    );
  }

  const allFilled = drafts.length > 0 && drafts.every((d) => isDraftFilled(d.kind, d.fields));

  // This used to be a window.confirm, but a password-protected card needs to collect a
  // password before writing, and a native confirm dialog can't have an input field — so this
  // was changed to an inline confirmation panel: clicking "write" first enters the confirming
  // state, the panel shows a password field if needed, and actually starting the write requires
  // one more click inside the panel to confirm.
  function requestWrite() {
    if (!allFilled || !card) return;
    setWritePassword("");
    setResult(null);
    setError(null);
    setConfirming(true);
  }

  function cancelConfirm() {
    setConfirming(false);
    setWritePassword("");
  }

  async function confirmWrite() {
    if (!card) return;
    if (protection?.enabled && !isValidPasswordHex(writePassword)) return;
    const records = drafts.map((d) => ({ kind: d.kind, content: buildContent(d.kind, d.fields) }));

    // There's a time gap between clicking confirm and actually executing — remember which
    // card (UID) it was at that moment; the backend re-checks this right before actually
    // writing, and aborts instead of writing to a different card if it was swapped out.
    const targetUid = card.uid;
    const password = protection?.enabled ? writePassword.trim() : undefined;
    cancelledRef.current = false;
    setConfirming(false);
    setWritePassword("");
    setWriting(true);
    setError(null);
    setResult(null);
    logFrontend("info", `Writing ${records.length} record(s) to ${targetUid}`);
    try {
      await invoke("write_ndef", { records, expectedUid: targetUid, password });
      if (cancelledRef.current) {
        logFrontend("info", "Write finished, but the user had already clicked cancel — not showing the result");
        return;
      }
      setResult(t("write.writeSuccess"));
      logFrontend("info", "Write succeeded");
    } catch (e) {
      if (cancelledRef.current) {
        logFrontend("info", `Write failed (already cancelled, ignoring): ${String(e)}`);
        return;
      }
      setError(String(e));
      logFrontend("error", `Write failed: ${String(e)}`);
    } finally {
      if (!cancelledRef.current) setWriting(false);
    }
  }

  function handleCancel() {
    // The backend call has already been sent — there's no safe way to interrupt a serial
    // command partway through (if it happens to land right in the middle of writing a page,
    // interrupting it could actually corrupt the card instead). What this can do is stop the UI
    // from waiting on it and showing the result, letting the user immediately switch to reading
    // another card; the actual write command may still finish running in the background.
    cancelledRef.current = true;
    setWriting(false);
    setError(null);
    setResult(null);
    logFrontend("info", "User cancelled waiting for the write result");
  }

  if (!connectedPort) {
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-4 pt-8">
        <p className="text-center text-sm text-muted-foreground">{t("readCard.connectFirst")}</p>
      </div>
    );
  }

  if (!card) {
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-4 pt-8">
        <p className="text-center text-sm text-muted-foreground">{t("readCard.waitingForCard")}</p>
      </div>
    );
  }

  const isNtagFamily = card.sel_res === "00";

  if (!isNtagFamily) {
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-4 pt-8">
        <p className="text-center text-sm text-muted-foreground">
          {t("write.unsupportedCardType", { type: card.card_type })}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-3 pt-8">
      {drafts.map((draft) => (
        <div key={draft.id} className="flex flex-col gap-2 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <select
              className="flex-1 rounded-md border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
              value={draft.kind}
              onChange={(e) => setKind(draft.id, e.target.value as RecordKind)}
              disabled={writing}
            >
              {(Object.keys(KIND_LABEL_KEYS) as RecordKind[]).map((k) => (
                <option key={k} value={k}>
                  {t(KIND_LABEL_KEYS[k])}
                </option>
              ))}
            </select>
            {drafts.length > 1 && (
              <button
                className="rounded-md border px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                onClick={() => removeDraft(draft.id)}
                disabled={writing}
              >
                {t("write.deleteRecord")}
              </button>
            )}
          </div>
          <RecordFields
            draft={draft}
            disabled={writing}
            onChange={(field, value) => setField(draft.id, field, value)}
          />
        </div>
      ))}

      <button
        className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        onClick={addDraft}
        disabled={writing}
      >
        {t("write.addRecord")}
      </button>

      {writing ? (
        <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-sm">
          <span className="flex-1 text-muted-foreground">
            {t("write.writingInProgress", { uid: card.uid })}
          </span>
          <button
            className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted"
            onClick={handleCancel}
          >
            {t("common.cancel")}
          </button>
        </div>
      ) : confirming ? (
        <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
          <p>
            {t("write.confirmOverwrite", { count: drafts.length })}
          </p>
          {protection?.enabled && (
            <input
              className="rounded-md border bg-background px-3 py-1.5 text-sm font-mono disabled:opacity-50"
              placeholder={t("write.passwordPlaceholder")}
              value={writePassword}
              onChange={(e) => setWritePassword(e.target.value)}
              autoFocus
            />
          )}
          <div className="flex justify-end gap-2">
            <button
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
              onClick={cancelConfirm}
            >
              {t("common.cancel")}
            </button>
            <button
              className="rounded-md border bg-secondary px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
              onClick={confirmWrite}
              disabled={!!protection?.enabled && !isValidPasswordHex(writePassword)}
            >
              {t("write.confirmWrite")}
            </button>
          </div>
        </div>
      ) : (
        <button
          className="rounded-md border bg-secondary px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
          onClick={requestWrite}
          disabled={!allFilled}
        >
          {t("write.writeButton")}{drafts.length > 1 ? t("write.writeCountSuffix", { count: drafts.length }) : ""}
        </button>
      )}

      {result && <p className="text-sm text-green-600">{result}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
