import { useCallback, useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { logFrontend } from "@/lib/devLog";

export type UpdateCheckState =
  | { phase: "checking" }
  | { phase: "upToDate" }
  | { phase: "available"; update: Update }
  | { phase: "installing" }
  | { phase: "error" };

/**
 * Owned at the App level (not inside AboutDialog) so the update check runs once at app startup —
 * "as if the user had opened About and clicked check" — and its result stays put across opening/
 * closing the About dialog rather than resetting back to nothing every time the dialog remounts.
 */
export function useUpdateCheck() {
  const [state, setState] = useState<UpdateCheckState>({ phase: "checking" });

  const recheck = useCallback(async () => {
    setState({ phase: "checking" });
    try {
      const update = await check();
      setState(update ? { phase: "available", update } : { phase: "upToDate" });
      logFrontend("info", update ? `Update available: ${update.version}` : "Already on the latest version");
    } catch (e) {
      setState({ phase: "error" });
      logFrontend("error", `Update check failed: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    recheck();
  }, [recheck]);

  async function install(update: Update) {
    setState({ phase: "installing" });
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      setState({ phase: "error" });
      logFrontend("error", `Update install failed: ${String(e)}`);
    }
  }

  return { state, recheck, install };
}

export type UseUpdateCheck = ReturnType<typeof useUpdateCheck>;
