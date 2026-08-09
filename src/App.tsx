import { useEffect, useState } from "react";
import { Cable, CreditCard, KeyRound, Pencil } from "lucide-react";
import { TitleBar } from "./components/TitleBar";
import { Sidebar, type NavItem } from "./components/Sidebar";
import { ComingSoon } from "./components/ComingSoon";
import { DevicePage } from "./components/DevicePage";
import { ReadCardPage } from "./components/ReadCardPage";
import { WritePage } from "./components/WritePage";
import { OtherPage } from "./components/OtherPage";
import { DevPanel } from "./components/DevPanel";
import { AboutDialog } from "./components/AboutDialog";
import { initDevLogBridge } from "./lib/devLog";
import { usePn532Connection } from "./hooks/usePn532Connection";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { useI18n } from "./lib/i18n";
import type { RecordDraft } from "./lib/writeRecords";

type PageId = "device" | "read" | "write" | "other" | "settings";

function App() {
  const [devPanelOpen, setDevPanelOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [activePage, setActivePage] = useState<PageId>("device");
  const conn = usePn532Connection();
  const updateCheck = useUpdateCheck();
  const { t } = useI18n();
  // Bumped every time the "clear" button is clicked — paired with the `key` on ReadCardPage
  // below, so React tears down and rebuilds the whole read page (and its children, like the
  // sector table) back to a clean state as if the user had just landed on a fresh read, instead
  // of manually threading a signal/callback between components to sync "has it been cleared".
  const [readResetSeq, setReadResetSeq] = useState(0);
  // Set by "write" on a saved-data entry (Other -> Saved data) — the write page consumes this
  // once at mount to seed its editor, then this is cleared again so leaving and later coming
  // back to the write page on its own doesn't keep reloading the same stale content.
  const [pendingWriteDrafts, setPendingWriteDrafts] = useState<RecordDraft[] | null>(null);

  useEffect(() => {
    initDevLogBridge();
  }, []);

  function writeSavedRecords(drafts: RecordDraft[]) {
    setPendingWriteDrafts(drafts);
    setActivePage("write");
  }

  const navItems: NavItem[] = [
    { id: "device", label: t("nav.device"), icon: Cable },
    { id: "read", label: t("nav.read"), icon: CreditCard, disabled: !conn.connectedPort },
    { id: "write", label: t("nav.write"), icon: Pencil, disabled: !conn.connectedPort },
    { id: "other", label: t("nav.other"), icon: KeyRound, disabled: !conn.connectedPort },
    // "Settings" is temporarily hidden (the page itself, and the "settings" branch below, are
    // both still here — this entry can be added back at any time).
  ];

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <TitleBar
        onOpenDevPanel={() => setDevPanelOpen((v) => !v)}
        onOpenAbout={() => setAboutOpen(true)}
      />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          items={navItems}
          active={activePage}
          onSelect={(id) => setActivePage(id as PageId)}
        />
        <main className="flex-1 overflow-auto p-6">
          {activePage === "device" && (
            <DevicePage
              scanState={conn.scanState}
              devices={conn.devices}
              selectedPort={conn.selectedPort}
              onSelectPort={conn.setSelectedPort}
              connecting={conn.connecting}
              connectedPort={conn.connectedPort}
              connectedDeviceInfo={conn.connectedDeviceInfo}
              connectedPortSummary={conn.connectedPortSummary}
              connectError={conn.connectError}
              onScan={conn.scanDevices}
              onConnect={conn.connect}
              onDisconnect={conn.disconnect}
            />
          )}
          {/* This page stays mounted at all times and is only hidden with CSS — not the
              "don't render unless activePage matches" pattern used above. Reading a card in
              full (especially the Classic per-sector scan) takes a while; switching to another
              page and back shouldn't throw away everything already read and start over. Staying
              mounted means switching pages just hides it — its state and any in-flight requests
              are still there when you switch back. */}
          <div className={activePage === "read" ? undefined : "hidden"}>
            <ReadCardPage
              key={readResetSeq}
              active={activePage === "read"}
              connectedPort={conn.connectedPort}
              card={conn.card}
              detectionSeq={conn.detectionSeq}
              setPollingPaused={conn.setPollingPaused}
              requestPolling={conn.requestPolling}
              onClear={() => {
                conn.clearCard();
                setReadResetSeq((s) => s + 1);
              }}
            />
          </div>
          {activePage === "write" && (
            <WritePage
              connectedPort={conn.connectedPort}
              card={conn.card}
              detectionSeq={conn.detectionSeq}
              requestPolling={conn.requestPolling}
              initialDrafts={pendingWriteDrafts}
              onInitialDraftsConsumed={() => setPendingWriteDrafts(null)}
            />
          )}
          {activePage === "other" && (
            <OtherPage
              connectedPort={conn.connectedPort}
              card={conn.card}
              detectionSeq={conn.detectionSeq}
              active={activePage === "other"}
              setPollingPaused={conn.setPollingPaused}
              requestPolling={conn.requestPolling}
              onWriteRecords={writeSavedRecords}
            />
          )}
          {activePage === "settings" && (
            <ComingSoon
              title={t("settings.comingSoonTitle")}
              description={t("settings.comingSoonDescription")}
            />
          )}
        </main>
      </div>

      {devPanelOpen && (
        <DevPanel
          onClose={() => setDevPanelOpen(false)}
          card={conn.card}
          detectionSeq={conn.detectionSeq}
          requestPolling={conn.requestPolling}
          setPollingPaused={conn.setPollingPaused}
        />
      )}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} updateCheck={updateCheck} />}
    </div>
  );
}

export default App;
