import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logFrontend } from "@/lib/devLog";
import { useI18n } from "@/lib/i18n";
import type { CardInfo, ClassicCopyResult, ClassicSectorInfo } from "@/lib/pn532Types";

export function ClassicCopyFlow({
  sourceUid,
  sourceSectors,
  currentCard,
  onClose,
  setPollingPaused,
}: {
  sourceUid: string;
  sourceSectors: ClassicSectorInfo[];
  currentCard: CardInfo | null;
  onClose: () => void;
  /** Pause background polling while writing, so it doesn't compete for the antenna with
   * authentication/writing. */
  setPollingPaused: (paused: boolean) => void;
}) {
  const { t } = useI18n();
  const [copying, setCopying] = useState(false);
  const [results, setResults] = useState<ClassicCopyResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  // The target card UID already handled — prevents a repeat write being triggered by another
  // poll detecting the same card again before it's been taken away.
  const lastHandledUidRef = useRef<string | null>(null);

  const isClassic = currentCard != null && (parseInt(currentCard.sel_res, 16) & 0x08) !== 0;
  const isNewTarget =
    isClassic && currentCard!.uid !== sourceUid && currentCard!.uid !== lastHandledUidRef.current;
  const unlockedSectors = sourceSectors.filter((s) => s.key);

  // The card is already in place; as soon as it's detected, write immediately — no need for
  // the user to click a button again or confirm in a dialog. Clicking into this flow in the
  // first place already was the confirmation, and there's no free hand to click things while
  // holding a card.
  //
  // In React StrictMode dev mode, every effect runs twice in a row (to help catch missing
  // cleanup functions). Calling handleCopy synchronously here would genuinely fire two write
  // requests at the hardware — a duplicate read request just wastes one call, but a duplicate
  // write to a card actually writes it twice, which has to be avoided. Deferring the actual
  // call to a microtask, combined with the `cancelled` flag, works around this: StrictMode's
  // "mount → cleanup → mount again" all happens within the same synchronous pass, and a
  // microtask only runs after that pass finishes, so only the call from the final mount
  // actually triggers a write.
  useEffect(() => {
    if (!isNewTarget || copying) return;
    let cancelled = false;
    const target = currentCard!;
    queueMicrotask(() => {
      if (!cancelled) handleCopy(target);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNewTarget, currentCard?.uid]);

  // Restore the paused state too if the user navigates away mid-write (e.g. clicks "done").
  useEffect(() => {
    return () => setPollingPaused(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCopy(target: CardInfo) {
    lastHandledUidRef.current = target.uid;
    setPollingPaused(true);
    setCopying(true);
    setError(null);
    logFrontend("info", `Copying ${sourceUid} -> ${target.uid}`);
    try {
      const sectors = unlockedSectors.map((s) => ({
        sector: s.sector,
        key: s.key!,
        key_type: s.key_type!,
        blocks: s.blocks,
      }));
      const res = await invoke<ClassicCopyResult>("copy_classic_card", {
        sourceUid,
        sectors,
      });
      setResults((prev) => [res, ...prev]);
      logFrontend(
        "info",
        `Copy complete: ${res.sectors_written.length} sector(s) succeeded, ${res.sectors_failed.length} failed, UID clone ${res.uid_cloned ? "succeeded" : "failed"}`,
      );
    } catch (e) {
      setError(String(e));
      logFrontend("error", `Copy failed: ${String(e)}`);
    } finally {
      setCopying(false);
      setPollingPaused(false);
    }
  }

  const latest = results[0];

  return (
    <div className="rounded-md border p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-medium">
          {t("classicCopy.title")}
          {results.length > 0 && t("classicCopy.completedCount", { count: results.length })}
        </p>
        <button className="text-xs text-muted-foreground hover:underline" onClick={onClose}>
          {t("classicCopy.done")}
        </button>
      </div>

      <p className="text-sm text-muted-foreground">
        {copying
          ? t("classicCopy.writing")
          : currentCard?.uid === sourceUid
            ? t("classicCopy.stillSourceCard")
            : t("classicCopy.placeTargetCard")}
      </p>

      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

      {latest && (
        <div className="mt-3 flex flex-col gap-1 border-t pt-3 text-sm">
          <p>
            {t("classicCopy.lastTargetCard")}<span className="font-mono">{latest.target_uid}</span>
          </p>
          <p>
            {t("classicCopy.uidCloneLabel")}
            {latest.uid_cloned ? (
              <span className="text-green-600">{t("classicCopy.uidCloneSucceeded")}</span>
            ) : (
              <span className="text-muted-foreground">{t("classicCopy.uidCloneFailed")}</span>
            )}
          </p>
          <p>
            {t("classicCopy.sectorsWritten", { count: latest.sectors_written.length })}
            {latest.sectors_failed.length > 0 && t("classicCopy.sectorsFailed", { count: latest.sectors_failed.length })}
          </p>
        </div>
      )}
    </div>
  );
}
