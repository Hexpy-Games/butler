import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiErrorCode } from "@/app/api";
import { appCopy, useAppLocale } from "@/app/copy";
import { onMemoryEvent } from "@/app/memoryEvents";
import { useButlerStore } from "@/app/store";
import { sessionFromNavigation } from "@/app/utils";
import { Button, ButtonContainer, ComposerDecisionPanel, FileText, Tooltip } from "@/butler-ds";

interface PendingInstruction {
  id: string;
  chat_id?: string;
  action: "remember" | "replace" | "forget";
  text: string | null;
  target: { text: string } | null;
  current: { text: string; revision: string } | null;
  conflict: boolean;
}

export function usePendingInstructions() {
  const chatId = useButlerStore((store) => store.activeChatId);
  const chat = useButlerStore((store) => sessionFromNavigation(store.navigation, chatId));
  const computerId = chat?.computer_id;
  const [result, setResult] = useState<{ chatId: string; items: PendingInstruction[] }>();
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    const { pending } = await api<{ pending: PendingInstruction[] }>("/memory/instructions/pending");
    if (request === generation.current) {
      setResult({ chatId, items: pending.filter((item) => item.chat_id === chatId) });
    }
  }, [chatId]);
  useEffect(() => {
    if (!computerId) return;
    void refresh().catch(() => {});
    const unsubscribe = onMemoryEvent((event) => {
      if (event.type === "remote.instruction_pending" && event.payload.computer_id === computerId) {
        void refresh().catch(() => {});
      }
    });
    return () => {
      generation.current++;
      unsubscribe();
    };
  }, [computerId, refresh]);
  return {
    computerName: chat?.computer_name,
    item: computerId && result?.chatId === chatId ? result.items[0] : undefined,
    refresh,
    remove(id: string) {
      setResult((value) => value?.chatId === chatId
        ? { chatId, items: value.items.filter((item) => item.id !== id) }
        : value);
    },
  };
}

export function PendingInstructionCard({ item, computerName, refresh, remove }: {
  item: PendingInstruction;
  computerName: string;
  refresh: () => Promise<void>;
  remove: (id: string) => void;
}) {
  useAppLocale();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const copy = appCopy.computers.pendingInstruction;
  const forget = item.action === "forget";
  const text = (forget ? item.target?.text : item.text) ?? "";
  const removed = item.conflict && item.current === null;

  async function decide(decision: "apply" | "discard") {
    setPending(true);
    setError(undefined);
    try {
      try {
        await api(`/memory/instructions/pending/${encodeURIComponent(item.id)}`, {
          method: "POST",
          body: JSON.stringify({ decision, expected_revision: item.current?.revision }),
        });
        remove(item.id);
      } catch (failure) {
        const code = apiErrorCode(failure);
        if (code === "instruction_changed") await refresh();
        else if (code === "pending_instruction_not_found") remove(item.id);
        else throw failure;
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : appCopy.interfaceFeedback.requestFailed);
    } finally {
      setPending(false);
    }
  }

  return <ComposerDecisionPanel icon={<FileText size="lg" aria-hidden="true" />}
    eyebrow={copy.eyebrow} title={forget ? copy.forgotten(computerName) : copy.saved(computerName)}
    onOpen={() => useButlerStore.getState().openSettings("memory")} error={error}
    details={item.conflict
      ? [...(item.current ? [copy.current, { quote: item.current.text }] : []),
        copy.incoming(computerName), { quote: text }, removed ? copy.removedHere : copy.replaceNotice]
      : [{ quote: text }]}
    actions={<ButtonContainer size="sm" justify="end">
      <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => void decide("discard")}>
        {copy.discard}
      </Button>
      <Tooltip label={removed ? copy.removed : undefined}>
        <Button type="button" size="sm" disabled={pending} aria-disabled={removed || undefined} onClick={() => {
          if (!removed) void decide("apply");
        }}>
          {copy.apply}
        </Button>
      </Tooltip>
    </ButtonContainer>} />;
}
