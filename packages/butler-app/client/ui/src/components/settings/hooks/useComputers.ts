import { useCallback, useEffect, useRef, useState } from "react";
import { apiErrorCode } from "@/app/api.ts";
import { setComputerConnection, useComputerConnections } from "@/app/computerEvents.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import type { ComputerConnection, MainModelKind } from "../computerTypes";
import { computerConnection, deleteComputer, forgetComputerMemory, listComputers, type Computer } from "../computersApi";

export type ComputerStatus = "connected" | "disconnected" | "aiNeeded" | "stopsOnLogout";

export function computerStatus(computer: Computer, connection: ComputerConnection): ComputerStatus {
  if (connection === "unreachable" || connection === "reconnecting") return "disconnected";
  if (!computer.ai_connected) return "aiNeeded";
  if (computer.stops_on_logout) return "stopsOnLogout";
  return "connected";
}

export function useComputers() {
  const [computers, setComputers] = useState<Computer[]>([]);
  const [mainModel, setMainModel] = useState<MainModelKind>("none");
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const revision = useRef(0);
  const removing = useRef(false);
  const states = useComputerConnections((store) => store.states);

  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const { computers: next, main_model } = await listComputers();
      if (!mounted.current || request !== revision.current) return;
      setComputers(next);
      setMainModel(main_model);
      setState("ready");
      for (const { id } of next) {
        void computerConnection(id).then(({ state }) => {
          if (mounted.current && request === revision.current) setComputerConnection(id, state);
        }).catch(() => {});
      }
    } catch {
      if (mounted.current && request === revision.current) setState("error");
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; revision.current++; };
  }, [refresh]);

  function statusOf(computer: Computer): ComputerStatus {
    return computerStatus(computer, states[computer.id] ?? "idle");
  }

  async function remove(computer: Computer, forget: boolean, force: boolean) {
    if (removing.current) return;
    removing.current = true;
    setBusy(true);
    const copy = appCopy.computers.removeDialog;
    try {
      const result = await deleteComputer(computer.id, force);
      if (!result.remote_cleaned) notifyStatus(copy.remoteNotCleaned, { id: "computers", tone: "error" });
      if (forget) {
        try {
          await forgetComputerMemory(computer.id);
        } catch (error) {
          notifyError(error, copy.forgetFailed, { id: "computers" });
        }
      }
      await refresh();
    } catch (error) {
      const code = apiErrorCode(error);
      if (code === "computer_unreachable") return "unreachable";
      if (code === "computer_not_synced") {
        notifyStatus(copy.notSynced, { id: "computers", tone: "error" });
      } else {
        notifyError(error, copy.removeFailed, { id: "computers" });
      }
    } finally {
      removing.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return { computers, mainModel, state, busy, refresh, remove, statusOf };
}
