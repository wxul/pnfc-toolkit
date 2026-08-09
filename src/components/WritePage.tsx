import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logFrontend } from "@/lib/devLog";
import { useI18n } from "@/lib/i18n";
import { cardFamily, isValidPasswordHex, type CardInfo, type PasswordProtection } from "@/lib/pn532Types";
import { Switch } from "@/components/ui/switch";
import { buildVCard, type VCardFields } from "@/lib/vcard";
import {
  buildContent,
  isDraftFilled,
  KIND_LABEL_KEYS,
  newDraft,
  type RecordDraft,
  type RecordKind,
} from "@/lib/writeRecords";

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
      const rawMode = draft.fields.mode === "raw";
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
      function toggleMode() {
        if (!rawMode) {
          // Seed the raw text from whatever's already in the form, but only the first time —
          // once there's raw text (typed by hand, or from loading an existing vCard), switching
          // back and forth must never clobber it with a form rebuild.
          if (!draft.fields.raw?.trim()) {
            onChange("raw", buildVCard(draft.fields as VCardFields));
          }
          onChange("mode", "raw");
        } else {
          onChange("mode", "form");
        }
      }
      return (
        <div className="flex flex-col gap-2">
          <div className="flex justify-end">
            <button
              type="button"
              className="text-xs text-muted-foreground hover:underline disabled:opacity-50"
              onClick={toggleMode}
              disabled={disabled}
            >
              {rawMode ? t("write.vcardSwitchToForm") : t("write.vcardSwitchToRaw")}
            </button>
          </div>
          {rawMode ? (
            <textarea
              className={`${inputClass} min-h-[220px] resize-y font-mono text-xs`}
              placeholder={t("write.vcardRawPlaceholder")}
              value={draft.fields.raw ?? ""}
              onChange={(e) => onChange("raw", e.target.value)}
              disabled={disabled}
            />
          ) : (
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
          )}
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

let nextLogId = 1;

interface WriteLogEntry {
  id: number;
  uid: string;
  ok: boolean;
  message: string;
  time: string;
}

// idle: content is being edited, nothing waiting — available as soon as the device is connected,
// no card needed yet.
// waiting: armed and registered with the shared poller. In single mode this covers exactly one
// card (writes once, then drops back to idle); in continuous mode it stays armed indefinitely,
// writing to every card placed until "stop" is clicked.
type Phase = "idle" | "waiting";

export function WritePage({
  connectedPort,
  card,
  detectionSeq,
  requestPolling,
  initialDrafts,
  onInitialDraftsConsumed,
}: {
  connectedPort: string | null;
  card: CardInfo | null;
  /** Bumped every time a card goes from "absent" to "present" — the trigger for noticing a new
   * card while `waiting`, not `card.uid` (the same card lifted off and set back down again
   * should still count as a new placement in continuous mode). */
  detectionSeq: number;
  /** Registers/unregisters this page's need for live card detection with the shared poller —
   * only needed while actually `waiting`, not just for having this page open (editing the
   * content doesn't need a card at all). */
  requestPolling: (id: string, want: boolean) => void;
  /** Set by "write" on a saved-data entry (see SavedCardsPage) — seeds the editor with that
   * record's content instead of the usual single blank URL draft. Only consulted once, at
   * mount (this page isn't kept mounted across navigation, so a fresh mount happens every time
   * the write tab is entered). */
  initialDrafts?: RecordDraft[] | null;
  /** Called once `initialDrafts` has been consumed, so the parent can clear it — otherwise
   * navigating away and back into the write page later (without a fresh "write" click from
   * saved data) would keep reloading the same stale content. */
  onInitialDraftsConsumed?: () => void;
}) {
  const { t } = useI18n();
  const [drafts, setDrafts] = useState<RecordDraft[]>(() => initialDrafts ?? [newDraft()]);
  const [continuous, setContinuous] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [password, setPassword] = useState("");
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [log, setLog] = useState<WriteLogEntry[]>([]);
  // The detectionSeq baseline as of the last time waiting started — see the comment in
  // `startWaiting` for why this is the current seq at that moment, not a fixed sentinel like 0.
  const armedSeqRef = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    requestPolling("write", phase === "waiting");
    return () => requestPolling("write", false);
  }, [phase, requestPolling]);

  useEffect(() => {
    if (phase !== "waiting" || !card || busyRef.current) return;
    if (detectionSeq === armedSeqRef.current) return;
    armedSeqRef.current = detectionSeq;
    void attemptWrite(card);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, card, detectionSeq]);

  // A disconnect mid-wait has nothing left to write to; drop back to editing instead of leaving
  // the UI stuck waiting for a card that can never show up.
  useEffect(() => {
    if (!connectedPort) setPhase("idle");
  }, [connectedPort]);

  useEffect(() => {
    if (initialDrafts) onInitialDraftsConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function appendLog(uid: string, ok: boolean, message: string) {
    setLog((prev) =>
      [{ id: nextLogId++, uid, ok, message, time: new Date().toLocaleTimeString() }, ...prev].slice(
        0,
        100,
      ),
    );
  }

  async function attemptWrite(target: CardInfo) {
    busyRef.current = true;
    setBusyUid(target.uid);
    try {
      const family = cardFamily(target.sel_res);
      if (family !== "ntag") {
        appendLog(
          target.uid,
          false,
          family === "classic" ? t("write.classicNotSupported") : t("write.unsupportedModel"),
        );
        return;
      }
      let pwd: string | undefined;
      let protectionInfo: PasswordProtection | null;
      try {
        protectionInfo = await invoke<PasswordProtection | null>("read_ntag_password_status");
      } catch (e) {
        appendLog(target.uid, false, `${t("write.checkFailed")}: ${String(e)}`);
        return;
      }
      if (protectionInfo?.enabled) {
        if (!isValidPasswordHex(password)) {
          appendLog(target.uid, false, t("write.passwordRequired"));
          return;
        }
        pwd = password.trim();
      }
      const records = drafts.map((d) => ({ kind: d.kind, content: buildContent(d.kind, d.fields) }));
      logFrontend("info", `Writing ${records.length} record(s) to ${target.uid}`);
      await invoke("write_ndef", { records, expectedUid: target.uid, password: pwd });
      appendLog(target.uid, true, t("write.writeSuccess"));
      logFrontend("info", `Write to ${target.uid} succeeded`);
    } catch (e) {
      appendLog(target.uid, false, String(e));
      logFrontend("error", `Write to ${target.uid} failed: ${String(e)}`);
    } finally {
      busyRef.current = false;
      setBusyUid(null);
      if (!continuous) setPhase("idle");
    }
  }

  function startWaiting() {
    if (!allFilled) return;
    // Baseline = the current seq, not 0 — `card`/`detectionSeq` can be stale left over from
    // before polling was off (e.g. a previous failed attempt dropped back to idle, and the card
    // was then removed with nobody polling to notice), so trusting them directly here risked
    // immediately attempting a write against a card that isn't there anymore ("no card present").
    // The poller resets its own presence tracking on resume (see `usePn532Connection`),
    // guaranteeing the first tick after this is a fresh, trustworthy check — including correctly
    // noticing a card that's been sitting there the whole time.
    armedSeqRef.current = detectionSeq;
    setPhase("waiting");
  }

  function stopWaiting() {
    setPhase("idle");
  }

  function addDraft() {
    setDrafts((prev) => [...prev, newDraft()]);
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

  if (!connectedPort) {
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-4">
        <p className="text-center text-sm text-muted-foreground">{t("readCard.connectFirst")}</p>
      </div>
    );
  }

  const locked = phase === "waiting";

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-3">
      {phase === "waiting" && (
        <div className="flex flex-col gap-2">
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            {t("write.overwriteWarning")}
          </div>
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-sm">
            <span className="flex-1 text-muted-foreground">
              {busyUid ? t("write.writingInProgress", { uid: busyUid }) : t("write.waitingForCard")}
            </span>
            <button className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted" onClick={stopWaiting}>
              {continuous ? t("write.stop") : t("common.cancel")}
            </button>
          </div>
        </div>
      )}

      {drafts.map((draft) => (
        <div key={draft.id} className="flex flex-col gap-2 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <select
              className="flex-1 rounded-md border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
              value={draft.kind}
              onChange={(e) => setKind(draft.id, e.target.value as RecordKind)}
              disabled={locked}
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
                disabled={locked}
              >
                {t("write.deleteRecord")}
              </button>
            )}
          </div>
          <RecordFields
            draft={draft}
            disabled={locked}
            onChange={(field, value) => setField(draft.id, field, value)}
          />
        </div>
      ))}

      <button
        className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        onClick={addDraft}
        disabled={locked}
      >
        {t("write.addRecord")}
      </button>

      {/* A settings toggle, not an action button — flipping it doesn't do anything by itself, it
          only decides what the "write" button below will do once clicked. Labeling both states
          explicitly (rather than just "continuous: on/off") keeps it readable without having to
          infer what the current position means. */}
      <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
        <span className="flex flex-col">
          <span className="text-sm font-medium">
            {continuous ? t("write.modeContinuous") : t("write.modeSingle")}
          </span>
          <span className="text-xs text-muted-foreground">{t("write.modeLabel")}</span>
        </span>
        <Switch checked={continuous} onCheckedChange={setContinuous} disabled={locked} />
      </label>

      <input
        className="rounded-md border bg-background px-3 py-1.5 text-sm font-mono disabled:opacity-50"
        placeholder={t("write.sharedPasswordPlaceholder")}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={locked}
      />

      {phase === "idle" && (
        <button
          className="rounded-md border bg-secondary px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
          onClick={startWaiting}
          disabled={!allFilled}
        >
          {continuous ? t("write.startContinuous") : t("write.writeButton")}
        </button>
      )}

      {log.length > 0 && (
        <div className="flex flex-col gap-1 rounded-md border p-2 text-xs">
          <div className="flex items-center justify-between px-1 pb-1 text-muted-foreground">
            <span>
              {t("write.successCount", { count: log.filter((e) => e.ok).length })}
              {" · "}
              {t("write.errorCount", { count: log.filter((e) => !e.ok).length })}
            </span>
            <button className="hover:underline" onClick={() => setLog([])}>
              {t("write.clearLog")}
            </button>
          </div>
          <div className="flex max-h-56 flex-col gap-1 overflow-auto">
            {log.map((entry) => (
              <div
                key={entry.id}
                className={`flex items-center gap-2 rounded px-1.5 py-1 ${
                  entry.ok ? "text-green-600" : "text-destructive"
                }`}
              >
                <span className="font-mono">{entry.uid}</span>
                <span className="flex-1">{entry.message}</span>
                <span className="text-muted-foreground">{entry.time}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
