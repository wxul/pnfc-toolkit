import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { deleteSavedTag, loadSavedTags, type SavedTag } from "@/lib/savedTags";
import { exportCardAsText, exportCardAsRawBinary } from "@/lib/exportCard";
import { canExportAsFlipperNfc, exportAsFlipperNfc } from "@/lib/flipperExport";
import { recordsToDrafts, type RecordDraft } from "@/lib/writeRecords";
import { logFrontend } from "@/lib/devLog";
import { formatUid } from "./CardInfoDisplay";
import { NtagDumpView } from "./NtagDumpView";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

type ExportFeedback = "done" | "error" | undefined;

/** Browses full tag saves made via the read page's "Save tag" button — unlike `SavedCardsPage`
 * (NDEF-only snapshots), each entry here keeps a complete `MemoryDump`, so it can be re-exported
 * as text, a Flipper `.nfc` file, or a raw `.bin` dump, not just text. NTAG/Ultralight only, same
 * as the save button itself — Classic cards don't have a structured full-page dump to save. */
export function SavedTagsPage({
  onWrite,
}: {
  /** Fired when "write" is clicked on a saved entry — same contract as `SavedCardsPage`'s
   * `onWrite`: only the NDEF content goes to the write page, none of this tag's other saved
   * info (UID, signature, counters, raw pages, ...). */
  onWrite: (drafts: RecordDraft[]) => void;
}) {
  const { t } = useI18n();
  const [tags, setTags] = useState<SavedTag[]>(() => loadSavedTags());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [exportFeedback, setExportFeedback] = useState<Record<string, ExportFeedback>>({});

  useEffect(() => {
    setTags(loadSavedTags());
  }, []);

  function handleDelete(id: string) {
    deleteSavedTag(id);
    setTags((prev) => prev.filter((tg) => tg.id !== id));
    if (expandedId === id) setExpandedId(null);
  }

  async function runExport(tag: SavedTag, label: string, doExport: () => Promise<boolean>) {
    try {
      const didExport = await doExport();
      if (!didExport) return; // User cancelled the save dialog.
      logFrontend("info", `Exported saved tag ${tag.uid} (${label})`);
      setExportFeedback((prev) => ({ ...prev, [tag.id]: "done" }));
    } catch (e) {
      logFrontend("error", `Failed to export saved tag ${tag.uid} (${label}): ${String(e)}`);
      setExportFeedback((prev) => ({ ...prev, [tag.id]: "error" }));
    } finally {
      setTimeout(() => setExportFeedback((prev) => ({ ...prev, [tag.id]: undefined })), 2000);
    }
  }

  if (tags.length === 0) {
    return (
      <div className="flex w-full flex-col gap-4">
        <p className="text-center text-sm text-muted-foreground">{t("savedTags.empty")}</p>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2">
      {tags.map((tg) => {
        const expanded = expandedId === tg.id;
        const feedback = exportFeedback[tg.id];
        return (
          <div key={tg.id} className="overflow-hidden rounded-md border">
            <div className="flex items-center gap-2 p-3 hover:bg-muted">
              <button
                className="flex flex-1 items-center gap-2 text-left"
                onClick={() => setExpandedId(expanded ? null : tg.id)}
              >
                {expanded ? (
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <div>
                  <p className="font-mono text-sm">{formatUid(tg.uid)}</p>
                  <p className="text-xs text-muted-foreground">
                    {tg.dump.chip_model || tg.dump.chip_model_guess || tg.dump.card_type} ·{" "}
                    {t("readCard.bytesValue", { n: tg.dump.pages.length * 4 })} · {formatTimestamp(tg.savedAt)}
                  </p>
                </div>
              </button>
              <button
                className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted"
                onClick={() => onWrite(recordsToDrafts(tg.dump.ndef_records))}
              >
                {t("savedCards.write")}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted">
                  {feedback === "done"
                    ? t("common.exported")
                    : feedback === "error"
                      ? t("common.exportFailed")
                      : t("common.export")}
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-auto min-w-fit whitespace-nowrap">
                  <DropdownMenuItem
                    className="whitespace-nowrap"
                    onClick={() =>
                      runExport(tg, "txt", () =>
                        exportCardAsText({
                          uid: tg.uid,
                          cardType: tg.dump.card_type,
                          sensRes: tg.sensRes,
                          selRes: tg.selRes,
                          ndefMessageHex: tg.dump.ndef_message_hex,
                          ndefRecords: tg.dump.ndef_records,
                        }),
                      )
                    }
                  >
                    {t("readCard.exportTxt")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="whitespace-nowrap"
                    disabled={!canExportAsFlipperNfc(tg.dump)}
                    title={canExportAsFlipperNfc(tg.dump) ? undefined : t("readCard.exportFlipperUnavailable")}
                    onClick={() =>
                      runExport(tg, "Flipper .nfc", () =>
                        exportAsFlipperNfc(tg.uid, tg.sensRes, tg.selRes, tg.dump),
                      )
                    }
                  >
                    {t("readCard.exportFlipperNfc")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="whitespace-nowrap"
                    onClick={() => runExport(tg, "raw binary", () => exportCardAsRawBinary(tg.uid, tg.dump))}
                  >
                    {t("readCard.exportRawBinary")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <button
                className="rounded-md border px-2.5 py-1 text-xs text-destructive hover:bg-destructive/10"
                onClick={() => handleDelete(tg.id)}
              >
                {t("common.delete")}
              </button>
            </div>
            {expanded && (
              <div className="border-t bg-muted/10 p-3">
                <NtagDumpView
                  dump={tg.dump}
                  uid={tg.uid}
                  sensRes={tg.sensRes}
                  selRes={tg.selRes}
                  cardType={tg.dump.card_type}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
