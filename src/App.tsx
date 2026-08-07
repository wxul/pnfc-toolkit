import { useEffect, useRef, useState } from "react";
import { Cable, CreditCard, Pencil } from "lucide-react";
import { TitleBar } from "./components/TitleBar";
import { Sidebar, type NavItem } from "./components/Sidebar";
import { ComingSoon } from "./components/ComingSoon";
import { DevicePage } from "./components/DevicePage";
import { ReadCardPage } from "./components/ReadCardPage";
import { WritePage } from "./components/WritePage";
import { DevPanel } from "./components/DevPanel";
import { AboutDialog } from "./components/AboutDialog";
import { initDevLogBridge } from "./lib/devLog";
import { usePn532Connection } from "./hooks/usePn532Connection";
import { useI18n } from "./lib/i18n";

type PageId = "device" | "read" | "write" | "settings";

function App() {
  const [devPanelOpen, setDevPanelOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [activePage, setActivePage] = useState<PageId>("device");
  const conn = usePn532Connection();
  const { t } = useI18n();
  const prevCardUidRef = useRef<string | null>(null);
  // Bumped every time the "clear" button is clicked — paired with the `key` on ReadCardPage
  // below, so React tears down and rebuilds the whole read page (and its children, like the
  // sector table) back to a clean state as if a card had just been detected, instead of
  // manually threading a signal/callback between components to sync "has it been cleared".
  const [readResetSeq, setReadResetSeq] = useState(0);

  useEffect(() => {
    initDevLogBridge();
  }, []);

  // Once connected, jump straight to the "read" page as soon as a (new) card is detected — no
  // need for the user to switch pages themselves.
  useEffect(() => {
    const uid = conn.card?.uid ?? null;
    if (uid && uid !== prevCardUidRef.current) {
      setActivePage("read");
    }
    prevCardUidRef.current = uid;
  }, [conn.card]);

  const navItems: NavItem[] = [
    { id: "device", label: t("nav.device"), icon: Cable },
    { id: "read", label: t("nav.read"), icon: CreditCard, disabled: !conn.connectedPort },
    { id: "write", label: t("nav.write"), icon: Pencil, disabled: !conn.connectedPort },
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
              key={`${conn.card?.uid ?? "none"}-${conn.detectionSeq}-${readResetSeq}`}
              connectedPort={conn.connectedPort}
              card={conn.card}
              setPollingPaused={conn.setPollingPaused}
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
              setPollingPaused={conn.setPollingPaused}
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

      {devPanelOpen && <DevPanel onClose={() => setDevPanelOpen(false)} />}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
    </div>
  );
}

export default App;
