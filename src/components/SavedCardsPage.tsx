import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { deleteSavedCard, loadSavedCards, type SavedCard } from "@/lib/savedCards";
import { recordsToDrafts, type RecordDraft } from "@/lib/writeRecords";
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
  const [cards, setCards] = useState<SavedCard[]>(() => loadSavedCards());
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Saving happens on a completely different page visit, so there's no live-update channel to
  // subscribe to — just re-read from storage every time this page is (re)entered.
  useEffect(() => {
    setCards(loadSavedCards());
  }, []);

  function handleDelete(id: string) {
    deleteSavedCard(id);
    setCards((prev) => prev.filter((c) => c.id !== id));
    if (expandedId === id) setExpandedId(null);
  }

  if (cards.length === 0) {
    return (
      <div className="flex w-full flex-col gap-4 pt-8">
        <p className="text-center text-sm text-muted-foreground">{t("savedCards.empty")}</p>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2 pt-8">
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
