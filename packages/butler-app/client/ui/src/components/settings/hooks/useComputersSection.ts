import { useState } from "react";
import { notifyStatus } from "@/app/notifications.ts";
import type { Computer } from "../computersApi";
import { useComputers } from "./useComputers";

export type ComputersSectionState = ReturnType<typeof useComputersSection>;

export function useComputersSection() {
  const computers = useComputers();
  const [adding, setAdding] = useState(false);
  const [aiFor, setAiFor] = useState<Computer | null>(null);
  const [removing, setRemoving] = useState<Computer | null>(null);

  function added(computer: Computer, failure?: string) {
    setAdding(false);
    void computers.refresh();
    if (failure) notifyStatus(failure, { id: "computers", tone: "error" });
    else setAiFor(computer);
  }

  function aiClosed() {
    void computers.refresh();
    setAiFor(null);
  }

  function confirmRemove(forget: boolean) {
    if (!removing) return;
    setRemoving(null);
    void computers.remove(removing, forget);
  }

  return { computers, adding, setAdding, aiFor, setAiFor, removing, setRemoving, added, aiClosed, confirmRemove };
}
