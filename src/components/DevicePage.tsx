import type { Pn532Info, SerialPortSummary } from "@/lib/pn532Types";
import { useI18n } from "@/lib/i18n";

type ScanState = "scanning" | "found" | "empty";

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-t px-3 py-1.5 text-sm first:border-t-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

export function DevicePage({
  scanState,
  devices,
  selectedPort,
  onSelectPort,
  connecting,
  connectedPort,
  connectedDeviceInfo,
  connectedPortSummary,
  connectError,
  onScan,
  onConnect,
  onDisconnect,
}: {
  scanState: ScanState;
  devices: Pn532Info[];
  selectedPort: string;
  onSelectPort: (port: string) => void;
  connecting: boolean;
  connectedPort: string | null;
  connectedDeviceInfo: Pn532Info | null;
  connectedPortSummary: SerialPortSummary | null;
  connectError: string | null;
  onScan: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const { t } = useI18n();

  // The IC byte is the chip model identifier — the only value confirmed against public
  // documentation so far is PN532's own (0x32).
  function chipNameFromIc(ic: number): string {
    return ic === 0x32 ? t("device.chipPn532") : t("device.chipUnknown", { ic: ic.toString(16).toUpperCase().padStart(2, "0") });
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4">
      {!connectedPort && scanState === "scanning" && (
        <p className="text-center text-sm text-muted-foreground">{t("device.scanning")}</p>
      )}

      {!connectedPort && scanState === "empty" && (
        <div className="flex flex-col items-center gap-3 rounded-md border p-6 text-center">
          <p className="text-sm text-muted-foreground">{t("device.notFound")}</p>
          <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" onClick={onScan}>
            {t("device.rescan")}
          </button>
        </div>
      )}

      {!connectedPort && scanState === "found" && (
        <>
          <div className="flex flex-col gap-1 rounded-md border p-1.5">
            {devices.map((d) => (
              <label
                key={d.port_name}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
              >
                <input
                  type="radio"
                  name="pn532-device"
                  checked={selectedPort === d.port_name}
                  onChange={() => onSelectPort(d.port_name)}
                />
                <span className="flex-1">
                  {d.friendly_name || d.port_name}
                  {d.friendly_name && (
                    <span className="ml-1 text-xs text-muted-foreground">({d.port_name})</span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  v{d.version}.{d.revision}
                </span>
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              className="flex-1 rounded-md border bg-secondary px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
              onClick={onConnect}
              disabled={connecting || !selectedPort}
            >
              {connecting ? t("device.connecting") : t("device.connect")}
            </button>
            <button className="rounded-md border px-2.5 py-1.5 text-sm hover:bg-muted" onClick={onScan}>
              {t("device.rescan")}
            </button>
          </div>
        </>
      )}

      {connectedPort && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col items-center gap-1 rounded-md border p-4 text-center">
            <p className="text-sm text-muted-foreground">{t("device.connected")}</p>
            <p className="text-sm font-medium">
              {connectedDeviceInfo?.friendly_name ||
                connectedPortSummary?.friendly_name ||
                connectedPortSummary?.product ||
                connectedPort}
            </p>
          </div>

          <div className="overflow-hidden rounded-md border">
            <InfoRow label={t("device.fieldPort")} value={connectedPort} />
            {connectedDeviceInfo && (
              <>
                <InfoRow label={t("device.fieldChip")} value={chipNameFromIc(connectedDeviceInfo.ic)} />
                <InfoRow
                  label={t("device.fieldFirmwareVersion")}
                  value={`v${connectedDeviceInfo.version}.${connectedDeviceInfo.revision}`}
                />
                <InfoRow
                  label={t("device.fieldSupportByte")}
                  value={`0x${connectedDeviceInfo.support.toString(16).toUpperCase().padStart(2, "0")}`}
                />
              </>
            )}
            {connectedPortSummary?.manufacturer && (
              <InfoRow label={t("device.fieldManufacturer")} value={connectedPortSummary.manufacturer} />
            )}
            {connectedPortSummary?.product && (
              <InfoRow label={t("device.fieldProductName")} value={connectedPortSummary.product} />
            )}
            {connectedPortSummary?.vid != null && connectedPortSummary?.pid != null && (
              <InfoRow
                label={t("device.fieldVidPid")}
                value={`${connectedPortSummary.vid.toString(16).toUpperCase().padStart(4, "0")}:${connectedPortSummary.pid.toString(16).toUpperCase().padStart(4, "0")}`}
              />
            )}
            {connectedPortSummary?.serial_number && (
              <InfoRow label={t("device.fieldSerialNumber")} value={connectedPortSummary.serial_number} />
            )}
          </div>

          <div className="overflow-hidden rounded-md border">
            <p className="border-b bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
              {t("device.supportedTypesTitle")}
            </p>
            <ul className="px-3 py-2 text-sm">
              <li>{t("device.supportedTypeNtag")}</li>
              <li>{t("device.supportedTypeClassic")}</li>
            </ul>
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              {t("device.supportedTypesHint")}
            </p>
          </div>

          <div className="flex justify-center">
            <button
              className="rounded-md border bg-destructive/10 px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/20"
              onClick={onDisconnect}
            >
              {t("device.disconnect")}
            </button>
          </div>
        </div>
      )}

      {connectError && <p className="text-sm text-destructive">{connectError}</p>}
    </div>
  );
}
