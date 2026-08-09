import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { MemoryDump } from "@/lib/pn532Types";
import { InfoRow, formatUid } from "./CardInfoDisplay";
import { NdefRecordList } from "./NdefRecordList";

/** GET_VERSION's reply is [Header, VendorID, ProductType, Subtype, MajorVer, MinorVer,
 * StorageSize, ProtocolType] — the only two bytes actually meaningful to show on their own
 * (the rest either duplicate what `chip_model`/`manufacturer` already show, or aren't meaningful
 * without a datasheet lookup table) are the chip's own major/minor firmware version. */
function chipFirmwareVersion(versionHex: string): string | null {
  if (versionHex.length < 12) return null;
  const major = parseInt(versionHex.slice(8, 10), 16);
  const minor = parseInt(versionHex.slice(10, 12), 16);
  return Number.isNaN(major) || Number.isNaN(minor) ? null : `${major}.${minor}`;
}

function hexToAscii(hex: string): string {
  let out = "";
  for (let i = 0; i < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    out += code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : "·";
  }
  return out;
}

type DetailTab = "ndef" | "raw";

/**
 * Renders an Ultralight/NTAG memory dump — the identity panel plus the NDEF/raw-data tabs.
 * Shared between the read page (`dump` fills in progressively as a live read completes, so it's
 * nullable there) and the saved-data viewer under "Other" (`dump` is always a finished record).
 * The identity fields (`uid`/`sensRes`/`selRes`/`cardType`) are passed separately rather than
 * read off `dump` because they come from the initial card detection, not the memory dump itself
 * — `MemoryDump` doesn't carry ATQA/SAK.
 */
export function NtagDumpView({
  dump,
  uid,
  sensRes,
  selRes,
  cardType,
}: {
  dump: MemoryDump | null;
  uid: string;
  sensRes: string;
  selRes: string;
  cardType: string;
}) {
  const { t } = useI18n();
  const [detailTab, setDetailTab] = useState<DetailTab>("ndef");

  const cc = dump?.capability_container;
  const hasNdefTlv = dump?.ndef_message_hex != null;
  const usedBytes = dump?.ndef_message_hex ? dump.ndef_message_hex.length / 2 : 0;
  const description = ["NFC-A", hasNdefTlv ? "Ndef" : undefined].filter(Boolean).join(",");
  const pwd = dump?.password_protection;
  const security = dump?.security;

  return (
    <>
      <div className="overflow-hidden rounded-md border">
        <p className="border-b bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">{t("readCard.tagInfo")}</p>
        <InfoRow label={t("readCard.fieldManufacturer")} value={dump?.manufacturer || t("common.unknown")} />
        <InfoRow label={t("readCard.fieldType")} value="ISO 14443-3A" />
        <InfoRow
          label={t("readCard.fieldModel")}
          value={dump?.chip_model || dump?.chip_model_guess || cardType}
        />
        <InfoRow label={t("readCard.fieldDescription")} value={description} />
        <InfoRow label={t("readCard.fieldId")} value={formatUid(uid)} />
        <InfoRow label="ATQA" value={`0x${sensRes}`} />
        <InfoRow label="SAK" value={`0x${selRes}`} />
        <InfoRow
          label={t("readCard.fieldDataFormat")}
          value={selRes === "00" ? "NFC Forum Type 2" : "-"}
        />
        {cc && <InfoRow label={t("readCard.fieldSize")} value={`${usedBytes}/${cc.capacity_bytes}`} />}
        {cc && <InfoRow label={t("readCard.fieldWritable")} value={cc.writable ? "true" : "false"} />}
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
        {security && chipFirmwareVersion(security.version_hex) && (
          <InfoRow label={t("readCard.fieldChipVersion")} value={chipFirmwareVersion(security.version_hex)!} />
        )}
        {security?.signature_hex && (
          <div className="border-t px-3 py-2 text-sm first:border-t-0">
            <p className="font-medium">{t("readCard.fieldSignature")}</p>
            <p className="mt-1 font-mono text-xs break-all text-right text-muted-foreground">
              {security.signature_hex}
            </p>
          </div>
        )}
        {security?.counter != null && (
          <InfoRow label={t("readCard.fieldCounter")} value={security.counter.toString()} />
        )}
        {security?.tearing_flag != null && (
          <InfoRow
            label={t("readCard.fieldTearingFlag")}
            value={
              security.tearing_flag === 0xbd
                ? t("readCard.tearingOk", { hex: security.tearing_flag.toString(16).toUpperCase().padStart(2, "0") })
                : t("readCard.tearingDetected", { hex: security.tearing_flag.toString(16).toUpperCase().padStart(2, "0") })
            }
          />
        )}
      </div>

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
            {detailTab === "ndef" && (
              <NdefRecordList
                hasNdefTlv={hasNdefTlv}
                records={dump.ndef_records}
                messageHex={dump.ndef_message_hex}
              />
            )}

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
    </>
  );
}
