import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logFrontend } from "@/lib/devLog";
import { useI18n } from "@/lib/i18n";
import {
  cardFamily,
  classicCapacityBytes,
  manufacturerFromUid,
  type CardInfo,
  type ClassicSectorInfo,
  type MemoryDump,
} from "@/lib/pn532Types";
import { saveCard } from "@/lib/savedCards";
import { saveTag } from "@/lib/savedTags";
import { exportCardAsText, exportCardAsRawBinary } from "@/lib/exportCard";
import { canExportAsFlipperNfc, exportAsFlipperNfc } from "@/lib/flipperExport";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ClassicSectorView } from "./ClassicSectorView";
import { ClassicCopyFlow } from "./ClassicCopyFlow";
import { NtagCopyFlow } from "./NtagCopyFlow";
import { NtagDumpView } from "./NtagDumpView";
import { InfoRow, formatUid } from "./CardInfoDisplay";

// idle: nothing read yet, waiting for the user to click "start reading".
// waiting: actively polling for a card (registered with the shared poller below).
// reading: a card was detected and captured into `activeCard` — polling turns back off, and the
// full read (NTAG dump / Classic sector scan, whichever the card's family needs) runs to
// completion, including its own automatic retries on a flaky read. Deliberately doesn't move on
// to another card once this finishes — reading one card is a complete, standalone action, not a
// continuous scan.
// done: the read finished successfully; results stay on screen until "clear".
type Phase = "idle" | "waiting" | "reading" | "done";

// "Clear" doesn't manage any "has it been cleared" flag inside this component — the parent
// (App.tsx) instead gives this component a `key` tied to a "reset" counter, and clicking "clear"
// just bumps that counter — React tears down and rebuilds this component and all its children
// (including ClassicSectorView's sector table) from scratch, landing back in `idle`, with no
// "cleared" flag to manually keep in sync.
export function ReadCardPage({
  connectedPort,
  card,
  detectionSeq,
  active,
  setPollingPaused,
  requestPolling,
  onClear,
}: {
  connectedPort: string | null;
  /** The live, continuously-updated detection result — only actually live while this page has
   * something registered with `requestPolling` (see below); otherwise it's whatever it was last
   * set to and shouldn't be rendered directly (use `activeCard`, the snapshot captured at
   * detection time, for that instead). */
  card: CardInfo | null;
  /** Bumped every time a card goes from "absent" to "present" — used the same way as in the
   * write page's batch mode, to notice a new card while `waiting`. */
  detectionSeq: number;
  /** Whether this is the currently visible page. Waiting for a card only registers with the
   * shared poller while this is true — switching to another page pauses the wait, switching back
   * resumes it, instead of polling on a page nobody's looking at. */
  active: boolean;
  /** Used to pause background polling while a multi-step operation (full memory read, sector
   * scan, etc.) is in progress, so it doesn't compete for the antenna. */
  setPollingPaused: (paused: boolean) => void;
  /** Registers/unregisters this page's need for live card detection with the shared poller. */
  requestPolling: (id: string, want: boolean) => void;
  /** Fired by clicking "clear" — the parent bumps this component's key, remounting it entirely
   * back to `idle`. */
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("idle");
  // The card this read run is about — captured once when detected and never touched again until
  // "clear" remounts the whole component. Deliberately not the same thing as the live `card`
  // prop: once this page stops polling, `card` is frozen at whatever it last was and may later
  // change again out from under it if some other page (e.g. write) resumes polling — rendering
  // must use this snapshot, not `card`, or the header (UID/ATQA/SAK) could end up showing a
  // different card than the dump/sector body below it.
  const [activeCard, setActiveCard] = useState<CardInfo | null>(null);
  // The detectionSeq baseline as of the last "start reading" click — see the comment in
  // `startReading` for why this is the current seq, not a fixed sentinel like 0.
  const armedSeqRef = useRef(0);
  const [dump, setDump] = useState<MemoryDump | null>(null);
  const [dumping, setDumping] = useState(false);
  const [dumpError, setDumpError] = useState<string | null>(null);
  const [classicSectors, setClassicSectors] = useState<ClassicSectorInfo[]>([]);
  const [classicSourceUid, setClassicSourceUid] = useState<string | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [ntagCopyOpen, setNtagCopyOpen] = useState(false);
  // Briefly shows "saved" on the save button after a click, then reverts — cheap feedback
  // without a full toast system.
  const [justSaved, setJustSaved] = useState(false);
  // Same idea, for the separate "save tag" (full dump, not just NDEF) button.
  const [justSavedTag, setJustSavedTag] = useState(false);
  // Same idea as `justSaved`, for the export-to-.txt button.
  const [exportState, setExportState] = useState<"idle" | "done" | "error">("idle");

  // Only two things on this page need live detection: actively waiting for the first card, and
  // the "copy to another card" flow (which — unlike the rest of this page — genuinely is a
  // continuous, multi-card operation, watching for each new target card swapped in). Both are
  // paused while the user isn't even looking at this page.
  useEffect(() => {
    requestPolling("read", active && (phase === "waiting" || copyOpen || ntagCopyOpen));
    return () => requestPolling("read", false);
  }, [active, phase, copyOpen, ntagCopyOpen, requestPolling]);

  // Captures whichever card shows up first while `waiting` — including one already sitting on
  // the reader the moment "start reading" was clicked.
  useEffect(() => {
    if (phase !== "waiting" || !card) return;
    if (detectionSeq === armedSeqRef.current) return;
    armedSeqRef.current = detectionSeq;
    setActiveCard(card);
    setPhase("reading");
  }, [phase, card, detectionSeq]);

  // dump_card_memory currently only understands Ultralight/NTAG (SAK=0x00); Classic cards go
  // through ClassicSectorView below instead, which starts its own scan as soon as it's mounted —
  // nothing to trigger here for that family. A card that's neither has nothing to read at all —
  // go straight to "done" showing the unsupported-model message, instead of sitting in "reading"
  // forever with no operation ever actually running. This only fires once per read run:
  // `activeCard` doesn't change again after being set, so once `phase` leaves "reading" this
  // condition can't become true again without a full remount (i.e. "clear").
  useEffect(() => {
    if (phase !== "reading" || !activeCard) return;
    const family = cardFamily(activeCard.sel_res);
    if (family === "ntag") {
      handleDumpMemory();
    } else if (family === "unsupported") {
      setPhase("done");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, activeCard]);

  // No need for the user to manually click "retry" on failure — as long as this read run is
  // still active, it retries automatically after a bit. The 1.5s interval is purely to avoid
  // hammering the reader nonstop while it's failing, not a retry count limit.
  useEffect(() => {
    if (!dumpError || !activeCard || activeCard.sel_res !== "00") return;
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
      if (!result) {
        // The card was lifted off between being detected and this read actually starting — not
        // a real error, just treat it the same as any other flaky-read failure and let the retry
        // effect above try again once it's back.
        setDumpError(t("readCard.dumpCardGone"));
        logFrontend("error", "Card was gone before the memory read finished");
        return;
      }
      setDump(result);
      setPhase("done");
      logFrontend("info", `Read complete, ${result.pages.length} page(s)`);
    } catch (e) {
      setDumpError(String(e));
      logFrontend("error", `Failed to read full memory: ${String(e)}`);
    } finally {
      setDumping(false);
      setPollingPaused(false);
    }
  }

  function startReading() {
    // Baseline = the current seq, not 0 — `card`/`detectionSeq` can be stale left over from
    // before polling was off (e.g. the card left the antenna during that gap with nobody polling
    // to notice), so trusting them directly here risked immediately "detecting" a card that
    // isn't actually there anymore. The poller resets its own presence tracking on resume (see
    // `usePn532Connection`), guaranteeing the first tick after this is a fresh, trustworthy
    // check — including correctly noticing a card that's been sitting there the whole time.
    armedSeqRef.current = detectionSeq;
    setPhase("waiting");
  }

  // NTAG-only (Classic isn't dumped page-by-page today, so there's nothing structured to save
  // for it yet) — only keeps the formatted NDEF data (records + the raw message hex), not the
  // rest of the read, so it can be browsed later from Other -> Saved data without needing the
  // card again.
  function handleSaveData() {
    if (!activeCard || !dump) return;
    saveCard({
      uid: activeCard.uid,
      ndefMessageHex: dump.ndef_message_hex,
      ndefRecords: dump.ndef_records,
    });
    logFrontend("info", `Saved ${activeCard.uid}'s NDEF data to the saved-data list`);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2000);
  }

  // Unlike `handleSaveData`, keeps the complete dump (every page, plus signature/counter data)
  // so a saved entry can later be re-exported as Flipper `.nfc`/raw `.bin`, not just text — see
  // `SavedTagsPage`.
  function handleSaveTag() {
    if (!activeCard || !dump) return;
    saveTag({
      uid: activeCard.uid,
      sensRes: activeCard.sens_res,
      selRes: activeCard.sel_res,
      dump,
    });
    logFrontend("info", `Saved ${activeCard.uid}'s full dump to the saved-tags list`);
    setJustSavedTag(true);
    setTimeout(() => setJustSavedTag(false), 2000);
  }

  async function runExport(label: string, doExport: () => Promise<boolean>) {
    try {
      const didExport = await doExport();
      if (!didExport) return; // User cancelled the save dialog.
      logFrontend("info", `Exported ${activeCard?.uid}'s data (${label})`);
      setExportState("done");
    } catch (e) {
      logFrontend("error", `Failed to export card data (${label}): ${String(e)}`);
      setExportState("error");
    } finally {
      setTimeout(() => setExportState("idle"), 2000);
    }
  }

  function handleExportTxt() {
    if (!activeCard || !dump) return;
    runExport("txt", () =>
      exportCardAsText({
        uid: activeCard.uid,
        cardType: activeCard.card_type,
        sensRes: activeCard.sens_res,
        selRes: activeCard.sel_res,
        ndefMessageHex: dump.ndef_message_hex,
        ndefRecords: dump.ndef_records,
      }),
    );
  }

  function handleExportFlipperNfc() {
    if (!activeCard || !dump) return;
    runExport("Flipper .nfc", () =>
      exportAsFlipperNfc(activeCard.uid, activeCard.sens_res, activeCard.sel_res, dump),
    );
  }

  function handleExportRawBinary() {
    if (!activeCard || !dump) return;
    runExport("raw binary", () => exportCardAsRawBinary(activeCard.uid, dump));
  }

  if (!connectedPort) {
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-4">
        <p className="text-center text-sm text-muted-foreground">{t("readCard.connectFirst")}</p>
      </div>
    );
  }

  if (phase === "idle") {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-4">
        <p className="text-center text-sm text-muted-foreground">{t("readCard.idleHint")}</p>
        <button
          className="rounded-md border bg-secondary px-4 py-2 text-sm font-medium hover:bg-muted"
          onClick={startReading}
        >
          {t("readCard.startRead")}
        </button>
      </div>
    );
  }

  if (phase === "waiting") {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-4">
        <p className="text-center text-sm text-muted-foreground">{t("readCard.waitingForCard")}</p>
        <button
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          onClick={() => setPhase("idle")}
        >
          {t("common.cancel")}
        </button>
      </div>
    );
  }

  // phase is "reading" or "done" past this point, so activeCard is always set — this null check
  // only exists to satisfy TypeScript's control-flow narrowing, it can't actually happen.
  if (!activeCard) return null;

  const family = cardFamily(activeCard.sel_res);

  if (family === "unsupported") {
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-4">
        <div className="flex justify-end">
          <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" onClick={onClear}>
            {t("common.clear")}
          </button>
        </div>
        <p className="text-center text-sm text-muted-foreground">
          {t("readCard.unsupportedModel", { sak: activeCard.sel_res })}
        </p>
      </div>
    );
  }

  if (family === "classic") {
    const unlockedCount = classicSectors.filter((s) => s.key).length;
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <div className="flex justify-end gap-2">
          {!copyOpen && (
            <button
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              onClick={() => {
                setClassicSourceUid(activeCard.uid);
                setCopyOpen(true);
              }}
              disabled={unlockedCount === 0}
            >
              {t("readCard.copyToAnotherCard")}
            </button>
          )}
          <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" onClick={onClear}>
            {t("common.clear")}
          </button>
        </div>
        <div className="overflow-hidden rounded-md border">
          <p className="border-b bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
            {t("readCard.tagInfo")}
          </p>
          <InfoRow label={t("readCard.fieldManufacturer")} value={manufacturerFromUid(activeCard.uid) || t("common.unknown")} />
          <InfoRow label={t("readCard.fieldType")} value="ISO 14443-3A" />
          <InfoRow label={t("readCard.fieldModel")} value={activeCard.card_type} />
          <InfoRow label={t("readCard.fieldDescription")} value="NFC-A" />
          <InfoRow label={t("readCard.fieldId")} value={formatUid(activeCard.uid)} />
          <InfoRow label="ATQA" value={`0x${activeCard.sens_res}`} />
          <InfoRow label="SAK" value={`0x${activeCard.sel_res}`} />
          <InfoRow label={t("readCard.fieldCapacity")} value={t("readCard.bytesValue", { n: classicCapacityBytes(activeCard.sel_res) })} />
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
          <ClassicSectorView
            card={activeCard}
            onSectorsChange={setClassicSectors}
            onScanComplete={() => setPhase("done")}
            setPollingPaused={setPollingPaused}
          />
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4">
      <div className="flex justify-end gap-2">
        {dump && (
          <button
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            onClick={handleSaveData}
          >
            {justSaved ? t("readCard.savedFeedback") : t("readCard.saveData")}
          </button>
        )}
        {dump && (
          <button
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            onClick={handleSaveTag}
          >
            {justSavedTag ? t("readCard.savedFeedback") : t("readCard.saveTag")}
          </button>
        )}
        {dump && (
          <DropdownMenu>
            <DropdownMenuTrigger className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
              {exportState === "done"
                ? t("common.exported")
                : exportState === "error"
                  ? t("common.exportFailed")
                  : t("common.export")}
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-auto min-w-fit whitespace-nowrap">
              <DropdownMenuItem className="whitespace-nowrap" onClick={handleExportTxt}>
                {t("readCard.exportTxt")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="whitespace-nowrap"
                disabled={!canExportAsFlipperNfc(dump)}
                title={canExportAsFlipperNfc(dump) ? undefined : t("readCard.exportFlipperUnavailable")}
                onClick={handleExportFlipperNfc}
              >
                {t("readCard.exportFlipperNfc")}
              </DropdownMenuItem>
              <DropdownMenuItem className="whitespace-nowrap" onClick={handleExportRawBinary}>
                {t("readCard.exportRawBinary")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {dump && !ntagCopyOpen && (
          <button
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            onClick={() => setNtagCopyOpen(true)}
          >
            {t("readCard.copyToAnotherCard")}
          </button>
        )}
        <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" onClick={onClear}>
          {t("common.clear")}
        </button>
      </div>

      {dump && ntagCopyOpen && (
        <NtagCopyFlow
          sourceUid={activeCard.uid}
          sourceMessageHex={dump.ndef_message_hex ?? ""}
          currentCard={card}
          onClose={() => setNtagCopyOpen(false)}
          setPollingPaused={setPollingPaused}
        />
      )}

      <NtagDumpView
        dump={dump}
        uid={activeCard.uid}
        sensRes={activeCard.sens_res}
        selRes={activeCard.sel_res}
        cardType={activeCard.card_type}
      />
      {dumping && <p className="text-xs text-muted-foreground">{t("readCard.readingFullInfo")}</p>}
      {dumpError && <p className="text-sm text-destructive">{dumpError}</p>}
    </div>
  );
}
