import { useState } from "react";
import { ChevronLeft, Eraser, KeyRound, Save, type LucideIcon } from "lucide-react";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import type { CardInfo } from "@/lib/pn532Types";
import type { RecordDraft } from "@/lib/writeRecords";
import { PasswordToolPage } from "./PasswordToolPage";
import { SavedCardsPage } from "./SavedCardsPage";
import { TagToolPage } from "./TagToolPage";

interface ToolDef {
  id: string;
  icon: LucideIcon;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
}

// The list of standalone card-operation tools that live under "Other" — grows over time without
// touching the picker screen below, just add an entry here and a case in the render switch.
const TOOLS: ToolDef[] = [
  {
    id: "password",
    icon: KeyRound,
    titleKey: "other.toolPasswordTitle",
    descriptionKey: "other.toolPasswordDesc",
  },
  {
    id: "saved",
    icon: Save,
    titleKey: "other.toolSavedTitle",
    descriptionKey: "other.toolSavedDesc",
  },
  {
    id: "tag",
    icon: Eraser,
    titleKey: "other.toolTagTitle",
    descriptionKey: "other.toolTagDesc",
  },
];

/**
 * "Other" is a picker screen for miscellaneous single-purpose card tools that don't belong on
 * the main Read/Write pages (e.g. setting a password without doing a full read first) — pick a
 * tool from the list, use it, then "back" returns to the list. Each tool gets a fresh instance
 * every time it's entered (no state is preserved across a visit), same as switching between the
 * main nav pages.
 */
export function OtherPage({
  connectedPort,
  card,
  detectionSeq,
  active,
  setPollingPaused,
  requestPolling,
  onWriteRecords,
}: {
  connectedPort: string | null;
  card: CardInfo | null;
  detectionSeq: number;
  active: boolean;
  setPollingPaused: (paused: boolean) => void;
  requestPolling: (id: string, want: boolean) => void;
  /** "Write" on a saved-data entry — the parent switches to the write page with these drafts
   * preloaded. */
  onWriteRecords: (drafts: RecordDraft[]) => void;
}) {
  const { t } = useI18n();
  const [selectedTool, setSelectedTool] = useState<string | null>(null);

  if (selectedTool) {
    // The saved-data list wants the full content width for its rows; the password tool is just
    // a short form and reads better kept narrow and centered like the rest of the app's forms.
    const wrapperClass =
      selectedTool === "saved"
        ? "flex w-full flex-col gap-3"
        : "mx-auto flex max-w-lg flex-col gap-3";
    return (
      <div className={wrapperClass}>
        <button
          className="flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setSelectedTool(null)}
        >
          <ChevronLeft className="h-4 w-4" />
          {t("other.back")}
        </button>
        {selectedTool === "password" && (
          <PasswordToolPage
            connectedPort={connectedPort}
            card={card}
            detectionSeq={detectionSeq}
            active={active}
            setPollingPaused={setPollingPaused}
            requestPolling={requestPolling}
          />
        )}
        {selectedTool === "saved" && <SavedCardsPage onWrite={onWriteRecords} />}
        {selectedTool === "tag" && (
          <TagToolPage
            connectedPort={connectedPort}
            card={card}
            detectionSeq={detectionSeq}
            active={active}
            setPollingPaused={setPollingPaused}
            requestPolling={requestPolling}
          />
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t("other.intro")}</p>
      <div className="flex flex-col gap-2">
        {TOOLS.map((tool) => {
          const Icon = tool.icon;
          return (
            <button
              key={tool.id}
              className="flex items-start gap-3 rounded-md border p-3 text-left hover:bg-muted"
              onClick={() => setSelectedTool(tool.id)}
            >
              <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{t(tool.titleKey)}</p>
                <p className="text-xs text-muted-foreground">{t(tool.descriptionKey)}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
