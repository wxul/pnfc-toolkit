import { Fragment, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logFrontend } from "@/lib/devLog";
import { useI18n } from "@/lib/i18n";
import { classicSectorCount, type CardInfo, type ClassicSectorInfo } from "@/lib/pn532Types";

export function ClassicSectorView({
  card,
  onSectorsChange,
  onScanComplete,
  setPollingPaused,
}: {
  card: CardInfo;
  /** Called every time the scan results change, so the parent (the copy feature) can get the
   * latest scanned sector data. */
  onSectorsChange?: (sectors: ClassicSectorInfo[]) => void;
  /** Fired once when a scan finishes every sector without being interrupted by an error or the
   * card being removed partway through — i.e. the read is genuinely complete, not just "the scan
   * loop stopped running". Not fired on a partial/interrupted scan (the auto-retry below will
   * eventually get there and fire it then). */
  onScanComplete?: () => void;
  /** Pause background polling during the scan, so it doesn't compete for the antenna with
   * per-sector authentication and interrupt it. */
  setPollingPaused: (paused: boolean) => void;
}) {
  const { t } = useI18n();
  const [sectors, setSectors] = useState<ClassicSectorInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Used to let a still-running loop from a previous round stop itself when the card changes
  // or a rescan starts — otherwise switching cards mid-scan would mix the old results in with
  // the new card's scan results.
  const scanTokenRef = useRef(0);

  async function scan() {
    const token = ++scanTokenRef.current;
    // Background polling is also competing for the antenna during per-sector authentication
    // (see the comment in usePn532Connection) — pause polling for the whole scan, and resume it
    // once it finishes (or gets interrupted). `finally` guarantees it gets resumed no matter
    // which path this exits through, but only after confirming this is still the "current" scan
    // — otherwise an old scan wrapping up could incorrectly turn off the pause a newer scan just
    // turned on.
    setPollingPaused(true);
    setScanning(true);
    setError(null);
    setSectors([]);
    setExpanded(null);
    // Distinguishes "the loop stopped because every sector was attempted" from "the loop broke
    // early" — `onScanComplete` should only fire for the former; `error` itself isn't usable for
    // this because the `setError` call above hasn't necessarily been applied to state yet by the
    // time this synchronous function reads it back.
    let interrupted = false;
    try {
      const total = classicSectorCount(card.sel_res);
      logFrontend("info", `Scanning ${total} sector(s) of ${card.uid}...`);
      for (let sector = 0; sector < total; sector++) {
        if (scanTokenRef.current !== token) return; // Card changed — stop feeding data into the stale results.
        try {
          const info = await invoke<ClassicSectorInfo | null>("read_classic_sector", { sector });
          if (scanTokenRef.current !== token) return;
          if (!info) {
            setError(t("classicSector.cardRemoved"));
            interrupted = true;
            break;
          }
          setSectors((prev) => [...prev, info]);
        } catch (e) {
          if (scanTokenRef.current !== token) return;
          setError(String(e));
          interrupted = true;
          logFrontend("error", `Failed to scan sector ${sector}: ${String(e)}`);
          break;
        }
      }
      if (scanTokenRef.current === token) {
        setScanning(false);
        logFrontend("info", "Sector scan finished");
        if (!interrupted) onScanComplete?.();
      }
    } finally {
      if (scanTokenRef.current === token) {
        setPollingPaused(false);
      }
    }
  }

  // This component is now "a brand new instance per card" (the parent controls this via a key
  // containing the UID), so it starts scanning as soon as it's mounted, with no need for some
  // prop change to trigger it — "clear" also works by having the parent swap out the key,
  // remounting this component, which naturally lands back here without a dedicated
  // clearSignal.
  useEffect(() => {
    // In React StrictMode dev mode, every effect runs twice in a row (to help catch missing
    // cleanup functions). Calling scan() synchronously here would genuinely fire two rounds of
    // scanning at the hardware (you'd see "scanning N sectors" logged twice, with the two
    // rounds of requests stepping on each other and interrupting authentication state).
    // Deferring the actual call to a microtask, combined with the `cancelled` flag, works
    // around this: StrictMode's "mount → cleanup → mount again" all happens within the same
    // synchronous pass, and a microtask only runs after that pass finishes, so only the call
    // from the final mount actually triggers a scan.
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) scan();
    });
    return () => {
      cancelled = true;
      setPollingPaused(false); // Also restore this if unmounted mid-scan (card change/clear/switching to the copy flow).
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // No need to manually click "rescan" on failure — as long as the card is still there (this
  // component hasn't unmounted), it retries automatically after a bit. The 1.5s is just to
  // avoid hammering the reader nonstop right after a failure; it'll keep retrying like this for
  // as long as the card stays there.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => scan(), 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  useEffect(() => {
    onSectorsChange?.(sectors);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectors]);

  const unlockedCount = sectors.filter((s) => s.key).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
        {scanning
          ? t("classicSector.scanningProgress", { current: sectors.length + 1, total: classicSectorCount(card.sel_res) })
          : t("classicSector.scanComplete", { unlocked: unlockedCount, total: sectors.length })}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="overflow-hidden rounded-md border">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b bg-muted/30 text-xs text-muted-foreground">
              <th className="px-3 py-1.5 font-normal">{t("classicSector.colSector")}</th>
              <th className="px-3 py-1.5 font-normal">{t("classicSector.colStatus")}</th>
              <th className="px-3 py-1.5 font-normal">{t("classicSector.colKey")}</th>
              <th className="px-3 py-1.5 font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {sectors.map((s) => (
              <Fragment key={s.sector}>
                <tr className="border-t">
                  <td className="px-3 py-1.5 font-mono">{s.sector}</td>
                  <td className="px-3 py-1.5">
                    {s.key ? (
                      <span className="text-green-600">{t("classicSector.unlocked")}</span>
                    ) : (
                      <span className="text-muted-foreground">{t("classicSector.locked")}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs">
                    {s.key ? `Key ${s.key_type}: ${s.key}` : "-"}
                  </td>
                  <td className="px-3 py-1.5">
                    {s.key && (
                      <button
                        className="text-xs text-primary hover:underline"
                        onClick={() => setExpanded(expanded === s.sector ? null : s.sector)}
                      >
                        {expanded === s.sector ? t("classicSector.collapse") : t("classicSector.viewData")}
                      </button>
                    )}
                  </td>
                </tr>
                {expanded === s.sector && (
                  <tr className="border-t bg-muted/20">
                    <td colSpan={4} className="px-3 py-2">
                      <table className="w-full font-mono text-xs">
                        <tbody>
                          {s.blocks.map((b) => (
                            <tr key={b.block}>
                              <td className="w-10 py-0.5 text-muted-foreground">{b.block}</td>
                              <td className="py-0.5">{b.hex}</td>
                              <td className="py-0.5 pl-2 text-muted-foreground">
                                {b.is_trailer ? t("classicSector.trailerLabel") : ""}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {!scanning && sectors.length > 0 && unlockedCount < sectors.length && (
        <p className="text-xs text-muted-foreground">{t("classicSector.unlockHint")}</p>
      )}
    </div>
  );
}
