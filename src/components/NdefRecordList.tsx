import { useI18n } from "@/lib/i18n";
import type { NdefRecordInfo } from "@/lib/pn532Types";

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

/** Renders parsed NDEF records plus the raw NDEF message hex — the "formatted NDEF data" view,
 * shared between the live read page and the saved-data list (which only keeps this subset of a
 * read, not the full raw page dump). */
export function NdefRecordList({
  hasNdefTlv,
  records,
  messageHex,
}: {
  hasNdefTlv: boolean;
  records: NdefRecordInfo[];
  messageHex?: string;
}) {
  const { t } = useI18n();

  if (!hasNdefTlv) {
    return <p className="text-sm text-muted-foreground">{t("readCard.noNdefDetected")}</p>;
  }
  if (records.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("readCard.ndefFormattedButEmpty")}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {records.map((r) => (
        <div key={r.index} className="rounded-md border p-3 text-sm">
          <p className="mb-2 font-medium">
            {t("readCard.recordLabel", { index: r.index })}{recordTitle(r)}
          </p>
          <p className="font-mono text-xs">Type: "{r.type_name}"</p>
          {r.uri && <p className="mt-1 font-mono text-xs break-all">URI: "{r.uri}"</p>}
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
      {messageHex && (
        <div className="rounded-md border p-3 text-sm">
          <p className="mb-1 text-xs text-muted-foreground">NDEF message:</p>
          <p className="font-mono text-xs break-all">{messageHex}</p>
        </div>
      )}
    </div>
  );
}
