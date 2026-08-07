import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logFrontend } from "@/lib/devLog";
import { useI18n } from "@/lib/i18n";
import {
  classicCapacityBytes,
  manufacturerFromUid,
  type CardInfo,
  type ClassicSectorInfo,
  type MemoryDump,
  type NdefRecordInfo,
} from "@/lib/pn532Types";
import { ClassicSectorView } from "./ClassicSectorView";
import { ClassicCopyFlow } from "./ClassicCopyFlow";
import { NtagPasswordProtection } from "./NtagPasswordProtection";

function hexToAscii(hex: string): string {
  let out = "";
  for (let i = 0; i < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    out += code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : "·";
  }
  return out;
}

function formatUid(uid: string): string {
  return uid.match(/.{1,2}/g)?.join(":") ?? uid;
}

const TNF_LABELS: Record<number, string> = {
  0: "Empty",
  1: "Well-known",
  2: "MIME Media",
  3: "Absolute URI",
  4: "External",
  5: "Unknown",
  6: "Unchanged",
  7: "Reserved",
};

function recordTitle(r: NdefRecordInfo): string {
  if (r.tnf === 1 && r.type_name === "U") return "URI record";
  if (r.tnf === 1 && r.type_name === "T") return "Text record";
  return `${TNF_LABELS[r.tnf] ?? "Unknown"} record`;
}

function payloadByteLines(hex: string): string[] {
  const bytes = hex.match(/.{1,2}/g) ?? [];
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 6) {
    const offset = i.toString(16).toUpperCase().padStart(2, "0");
    lines.push(`[${offset}] ${bytes.slice(i, i + 6).map((b) => `0x${b}`).join(" ")}`);
  }
  return lines;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-t px-3 py-2 text-sm first:border-t-0">
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">{value}</span>
    </div>
  );
}

type DetailTab = "ndef" | "raw";

// "Clear" doesn't manage any "has it been cleared" flag inside this component — the previous
// cleared/classicCleared setup, where child components notified each other via callbacks, would
// deadlock in "clearing..." forever if any single step got missed or a child unmounted at the
// wrong time. Now the parent (App.tsx) instead gives this component a `key` containing the card
// UID, and clicking "clear" just changes that key in App.tsx — React tears down and rebuilds
// this component and all its children (including ClassicSectorView's sector table) from
// scratch, automatically landing back in the clean state right after a card was detected, with
// no "cleared" flag to manually keep in sync.
export function ReadCardPage({
  connectedPort,
  card,
  setPollingPaused,
  onClear,
}: {
  connectedPort: string | null;
  card: CardInfo | null;
  /** Used to pause background polling while a multi-step operation (full memory read, sector
   * scan, etc.) is in progress, so it doesn't compete for the antenna. */
  setPollingPaused: (paused: boolean) => void;
  /** Fired by clicking "clear" — the parent swaps out this component's key, remounting it
   * entirely. */
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [dump, setDump] = useState<MemoryDump | null>(null);
  const [dumping, setDumping] = useState(false);
  const [dumpError, setDumpError] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("ndef");
  const [classicSectors, setClassicSectors] = useState<ClassicSectorInfo[]>([]);
  const [classicSourceUid, setClassicSourceUid] = useState<string | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);

  // This component is now "a brand new instance per card" (the key carries the UID) — it reads
  // the full info automatically as soon as a card is detected, without the user clicking
  // anything. dump_card_memory currently only understands Ultralight/NTAG (SAK=0x00); Classic
  // cards go through the separate ClassicSectorView below.
  useEffect(() => {
    // In React StrictMode dev mode, every effect runs twice in a row (to help catch missing
    // cleanup functions) — calling handleDumpMemory synchronously here would genuinely fire two
    // read requests at the hardware, stepping on each other. Deferring the actual call to a
    // microtask, combined with the `cancelled` flag, works around this: StrictMode's
    // "mount → cleanup → mount again" all happens within the same synchronous pass, and a
    // microtask only runs after that pass finishes, so only the call from the final mount
    // actually executes.
    let cancelled = false;
    if (card && card.sel_res === "00") {
      queueMicrotask(() => {
        if (!cancelled) handleDumpMemory();
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // No need for the user to manually click "retry" on failure — as long as the card is still
  // there (this component hasn't unmounted), it retries automatically after a bit. The 1.5s
  // interval is purely to avoid hammering the reader nonstop while it's failing, not a retry
  // count limit.
  useEffect(() => {
    if (!dumpError || !card || card.sel_res !== "00") return;
    const timer = setTimeout(() => handleDumpMemory(), 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dumpError]);

  async function handleDumpMemory() {
    setPollingPaused(true);
    setDumping(true);
    setDumpError(null);
    logFrontend("info", "Reading full card memory...");
    try {
      const result = await invoke<MemoryDump | null>("dump_card_memory");
      setDump(result);
      logFrontend("info", `Read complete, ${result?.pages.length ?? 0} page(s)`);
    } catch (e) {
      setDumpError(String(e));
      logFrontend("error", `Failed to read full memory: ${String(e)}`);
    } finally {
      setDumping(false);
      setPollingPaused(false);
    }
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

  const isClassicFamily = (parseInt(card.sel_res, 16) & 0x08) !== 0;
  if (isClassicFamily) {
    const unlockedCount = classicSectors.filter((s) => s.key).length;
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 pt-8">
        <div className="overflow-hidden rounded-md border">
          <p className="border-b bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
            {t("readCard.tagInfo")}
          </p>
          <InfoRow label={t("readCard.fieldManufacturer")} value={manufacturerFromUid(card.uid) || t("common.unknown")} />
          <InfoRow label={t("readCard.fieldType")} value="ISO 14443-3A" />
          <InfoRow label={t("readCard.fieldModel")} value={card.card_type} />
          <InfoRow label={t("readCard.fieldDescription")} value="NFC-A" />
          <InfoRow label={t("readCard.fieldId")} value={formatUid(card.uid)} />
          <InfoRow label="ATQA" value={`0x${card.sens_res}`} />
          <InfoRow label="SAK" value={`0x${card.sel_res}`} />
          <InfoRow label={t("readCard.fieldCapacity")} value={t("readCard.bytesValue", { n: classicCapacityBytes(card.sel_res) })} />
        </div>

        {copyOpen && classicSourceUid ? (
          <ClassicCopyFlow
            sourceUid={classicSourceUid}
            sourceSectors={classicSectors}
            currentCard={card}
            onClose={() => setCopyOpen(false)}
            setPollingPaused={setPollingPaused}
          />
        ) : (
          <>
            <ClassicSectorView
              card={card}
              onSectorsChange={setClassicSectors}
              setPollingPaused={setPollingPaused}
            />
            <div className="flex justify-center gap-2">
              <button
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                onClick={() => {
                  setClassicSourceUid(card.uid);
                  setCopyOpen(true);
                }}
                disabled={unlockedCount === 0}
              >
                {t("readCard.copyToAnotherCard")}
              </button>
              <button
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                onClick={onClear}
                disabled={classicSectors.length === 0}
              >
                {t("common.clear")}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  const cc = dump?.capability_container;
  const hasNdefTlv = dump?.ndef_message_hex != null;
  const usedBytes = dump?.ndef_message_hex ? dump.ndef_message_hex.length / 2 : 0;
  const description = ["NFC-A", hasNdefTlv ? "Ndef" : undefined].filter(Boolean).join(",");
  const pwd = dump?.password_protection;

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 pt-8">
      <div className="overflow-hidden rounded-md border">
        <p className="border-b bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">{t("readCard.tagInfo")}</p>
        <InfoRow label={t("readCard.fieldManufacturer")} value={dump?.manufacturer || t("common.unknown")} />
        <InfoRow label={t("readCard.fieldType")} value="ISO 14443-3A" />
        <InfoRow
          label={t("readCard.fieldModel")}
          value={
            dump?.chip_model || dump?.chip_model_guess || card.card_type
          }
        />
        <InfoRow label={t("readCard.fieldDescription")} value={description} />
        <InfoRow label={t("readCard.fieldId")} value={formatUid(card.uid)} />
        <InfoRow label="ATQA" value={`0x${card.sens_res}`} />
        <InfoRow label="SAK" value={`0x${card.sel_res}`} />
        <InfoRow
          label={t("readCard.fieldDataFormat")}
          value={card.sel_res === "00" ? "NFC Forum Type 2" : "-"}
        />
        {cc && <InfoRow label={t("readCard.fieldSize")} value={`${usedBytes}/${cc.capacity_bytes}`} />}
        {cc && <InfoRow label={t("readCard.fieldWritable")} value={cc.writable ? "true" : "false"} />}
        {cc && <InfoRow label={t("readCard.fieldCanBeReadOnly")} value="true" />}
        {pwd && (
          <InfoRow
            label={t("readCard.fieldPasswordProtection")}
            value={
              pwd.enabled
                ? t("readCard.passwordEnabled", { auth0: pwd.auth0.toString(16).toUpperCase().padStart(2, "0") })
                : t("readCard.passwordDisabled", { auth0: pwd.auth0.toString(16).toUpperCase().padStart(2, "0") })
            }
          />
        )}
        {dumping && <p className="px-3 py-2 text-xs text-muted-foreground">{t("readCard.readingFullInfo")}</p>}
      </div>

      {dumpError && <p className="text-sm text-destructive">{dumpError}</p>}

      {dump && (
        <div className="rounded-md border">
          <div className="flex border-b text-sm">
            <button
              className={`flex-1 py-2 ${detailTab === "ndef" ? "border-b-2 border-primary font-medium" : "text-muted-foreground"}`}
              onClick={() => setDetailTab("ndef")}
            >
              {t("readCard.tabNdefData")}
            </button>
            <button
              className={`flex-1 py-2 ${detailTab === "raw" ? "border-b-2 border-primary font-medium" : "text-muted-foreground"}`}
              onClick={() => setDetailTab("raw")}
            >
              {t("readCard.tabAllData")}
            </button>
          </div>

          <div className="p-3">
            {detailTab === "ndef" &&
              (!hasNdefTlv ? (
                <p className="text-sm text-muted-foreground">
                  {t("readCard.noNdefDetected")}
                </p>
              ) : dump.ndef_records.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("readCard.ndefFormattedButEmpty")}
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  {dump.ndef_records.map((r) => (
                    <div key={r.index} className="rounded-md border p-3 text-sm">
                      <p className="mb-2 font-medium">
                        {t("readCard.recordLabel", { index: r.index })}{recordTitle(r)}
                      </p>
                      <p className="font-mono text-xs">Type: "{r.type_name}"</p>
                      {r.uri && (
                        <p className="mt-1 font-mono text-xs break-all">URI: "{r.uri}"</p>
                      )}
                      <p className="mt-2 text-xs text-muted-foreground">Payload data:</p>
                      <pre className="font-mono text-xs whitespace-pre-wrap">
                        {payloadByteLines(r.payload_hex).join("\n")}
                      </pre>
                      {r.payload_text && (
                        <>
                          <p className="mt-2 text-xs text-muted-foreground">Payload data(UTF8):</p>
                          <pre className="font-mono text-xs whitespace-pre-wrap break-words">
                            {r.payload_text}
                          </pre>
                        </>
                      )}
                    </div>
                  ))}
                  {dump.ndef_message_hex && (
                    <div className="rounded-md border p-3 text-sm">
                      <p className="mb-1 text-xs text-muted-foreground">NDEF message:</p>
                      <p className="font-mono text-xs break-all">{dump.ndef_message_hex}</p>
                    </div>
                  )}
                </div>
              ))}

            {detailTab === "raw" &&
              (dump.pages.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("readCard.fullReadUnsupported")}
                </p>
              ) : (
                <>
                  <table className="w-full text-left font-mono text-xs">
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className="w-8 pb-1 font-normal">{t("readCard.colPage")}</th>
                        <th className="w-28 pb-1 font-normal">{t("readCard.colData")}</th>
                        <th className="w-16 pb-1 font-normal">{t("readCard.colAscii")}</th>
                        <th className="pb-1 font-normal">{t("readCard.colNote")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dump.pages.map((p) => (
                        <tr key={p.page} className="border-t">
                          <td className="py-0.5 text-muted-foreground">{p.page}</td>
                          <td className="py-0.5">{p.hex}</td>
                          <td className="py-0.5 text-muted-foreground">{hexToAscii(p.hex)}</td>
                          <td className="py-0.5 text-muted-foreground">{p.label || ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {dump.truncated_by_nak && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {dump.chip_model
                        ? t("readCard.truncatedKnownModel")
                        : t("readCard.truncatedUnknownModel")}
                    </p>
                  )}
                </>
              ))}
          </div>
        </div>
      )}

      {dump && (
        <NtagPasswordProtection
          card={card}
          passwordProtection={pwd}
          chipRecognized={!!dump.chip_model}
          setPollingPaused={setPollingPaused}
          onChanged={handleDumpMemory}
        />
      )}

      <div className="flex justify-center gap-2">
        <button
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          onClick={onClear}
          disabled={dumping || (!dump && !dumpError)}
        >
          {t("common.clear")}
        </button>
      </div>
    </div>
  );
}
