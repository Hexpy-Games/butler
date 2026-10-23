import { useRef, type Dispatch, type SetStateAction } from "react";
import { appCopy } from "@/app/copy.ts";
import type { CanonOverview } from "@/app/canonApi.ts";
import { notifyStatus } from "@/app/notifications.ts";
import type { KanbanMove } from "@/butler-ds";
import { canonWriteFailure } from "./canonFeedback.ts";
import { canComplete, canonCards, optimisticCanonMove } from "./canonLanes.ts";
import { persistCanonMove } from "./canonMove.ts";

export function useCanonMove(canon: CanonOverview | null, setCanon: Dispatch<SetStateAction<CanonOverview | null>>,
  refresh: () => Promise<void>, invalidate: () => void) {
  const moving = useRef(false);
  const move = async (move: KanbanMove) => {
    if (!canon || moving.current) return;
    if (!canComplete(canonCards(canon).find(card => card.id === move.itemId), move.toLaneId)) {
      notifyStatus(appCopy.canon.running, { tone: "error" }); return;
    }
    const previous = canon;
    moving.current = true;
    invalidate();
    setCanon(optimisticCanonMove(previous, move));
    try {
      const message = await persistCanonMove(previous, move);
      notifyStatus(message);
    } catch (error) {
      setCanon(previous);
      await canonWriteFailure(error, async () => {});
    } finally { moving.current = false; }
    await refresh();
  };
  return { move, moving };
}
