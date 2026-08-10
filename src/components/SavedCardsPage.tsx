import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { deleteSavedCard, loadSavedCards, type SavedCard } from "@/lib/savedCards";
import { recordsToDrafts, type RecordDraft } from "@/lib/writeRecords";
import { exportCardAsText } from "@/lib/exportCard";
import { logFrontend } from "@/lib/devLog";
import { formatUid } from "./CardInfoDisplay";
import { NdefRecordList } from "./NdefRecordList";

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

function usedBytes(card: SavedCard): number {
  return card.ndefMessageHex ? card.ndefMessageHex.length / 2 : 0;
}

/** Browses cards saved from the read page's "save data" button — pure local viewing/deleting,
 * doesn't touch the reader at all. Each row expands in place to show its NDEF data instead of
 * navigating to a separate screen, since there's nothing else (no raw pages, no tabs) left to
 * show now that saving only keeps the formatted NDEF data. */
export function SavedCardsPage({
  onWrite,
}: {
  /** Fired when "write" is clicked on a saved entry — the parent (App.tsx) loads the converted
   * drafts into the write page and switches to it. */
  onWrite: (drafts: RecordDraft[]) => void;
}) {
  const { t } = useI18n();
  const [cards, setCards] = useState<SavedCard[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Keyed by card id — same brief-feedback-then-revert idea as the read page's export button,
  // just per-row since this is a list instead of a single card.
  const [exportFeedback, setExportFeedback] = useState<Record<string, "done" | "error" | undefined>>({});

  // Saving happens on a completely different page visit, so there's no live-update channel to
  // subscribe to — just re-read from storage every time this page is (re)entered.
  useEffect(() => {
    loadSavedCards().then(setCards);
  }, []);

  async function handleDelete(id: string) {
    await deleteSavedCard(id);
    setCards((prev) => prev.filter((c) => c.id !== id));
    if (expandedId === id) setExpandedId(null);
  }

  async function handleExport(c: SavedCard) {
    try {
      const didExport = await exportCardAsText({
        uid: c.uid,
        ndefMessageHex: c.ndefMessageHex,
        ndefRecords: c.ndefRecords,
      });
      if (!didExport) return; // User cancelled the save dialog.
      logFrontend("info", `Exported saved card ${c.uid}'s NDEF data to a text file`);
      setExportFeedback((prev) => ({ ...prev, [c.id]: "done" }));
    } catch (e) {
      logFrontend("error", `Failed to export saved card data: ${String(e)}`);
      setExportFeedback((prev) => ({ ...prev, [c.id]: "error" }));
    } finally {
      setTimeout(() => setExportFeedback((prev) => ({ ...prev, [c.id]: undefined })), 2000);
    }
  }

  if (cards.length === 0) {
    return (
      <div className="flex w-full flex-col gap-4">
        <p className="text-center text-sm text-muted-foreground">{t("savedCards.empty")}</p>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2">
      {cards.map((c) => {
        const expanded = expandedId === c.id;
        return (
          <div key={c.id} className="overflow-hidden rounded-md border">
            <div className="flex items-center gap-2 p-3 hover:bg-muted">
              <button
                className="flex flex-1 items-center gap-2 text-left"
                onClick={() => setExpandedId(expanded ? null : c.id)}
              >
                {expanded ? (
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <div>
                  <p className="font-mono text-sm">{formatUid(c.uid)}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("readCard.bytesValue", { n: usedBytes(c) })} · {formatTimestamp(c.savedAt)}
                  </p>
                </div>
              </button>
              <button
                className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted"
                onClick={() => onWrite(recordsToDrafts(c.ndefRecords))}
              >
                {t("savedCards.write")}
              </button>
              <button
                className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted"
                onClick={() => handleExport(c)}
              >
                {exportFeedback[c.id] === "done"
                  ? t("common.exported")
                  : exportFeedback[c.id] === "error"
                    ? t("common.exportFailed")
                    : t("common.export")}
              </button>
              <button
                className="rounded-md border px-2.5 py-1 text-xs text-destructive hover:bg-destructive/10"
                onClick={() => handleDelete(c.id)}
              >
                {t("common.delete")}
              </button>
            </div>
            {expanded && (
              <div className="border-t bg-muted/10 p-3">
                <NdefRecordList
                  hasNdefTlv={c.ndefMessageHex != null}
                  records={c.ndefRecords}
                  messageHex={c.ndefMessageHex}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
