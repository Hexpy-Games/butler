import { useState } from "react";
import { notifyStatus } from "@/app/notifications.ts";
import type { Computer } from "../computersApi";
import { useComputers } from "./useComputers";

export type ComputersSectionState = ReturnType<typeof useComputersSection>;

export function useComputersSection() {
  const computers = useComputers();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Computer | null>(null);
  const [aiFor, setAiFor] = useState<Computer | null>(null);
  const [removing, setRemoving] = useState<{ computer: Computer; forget: boolean; unreachable: boolean } | null>(null);

  function added(computer: Computer, failure?: string) {
    setAdding(false);
    setEditing(null);
    void computers.refresh();
    if (failure) notifyStatus(failure, { id: "computers", tone: "error" });
    else if (computer.model_source === "chatgpt" && (editing?.model_source !== "chatgpt" || !computer.ai_connected)) {
      setAiFor(computer);
    }
  }

  function aiClosed() {
    void computers.refresh();
    setAiFor(null);
  }

  async function confirmRemove(forget: boolean, force: boolean) {
    if (!removing) return;
    const { computer } = removing;
    setRemoving(null);
    if (await computers.remove(computer, forget, force) === "unreachable") {
      setRemoving({ computer, forget, unreachable: true });
    }
  }

  return { computers, adding, setAdding, editing, setEditing, aiFor, removing, setRemoving, added, aiClosed, confirmRemove };
}
