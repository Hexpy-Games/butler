import { useEffect, useMemo, useRef, useState } from "react";
import { ACTIVE_TURN_STATES } from "@/app/constants.ts";
import { useButlerStore } from "@/app/store.ts";
import { activeTurnProgressSnapshot } from "@/app/utils.ts";
import { Wallpaper, setWallpaperHostConstrained, type ConversationColumnRect, type WallpaperContentRect, type WallpaperEvent } from "@/butler-ds";
import { usePowerState } from "@/hooks/usePowerState";
import { activeChatWallpaper } from "../mainScreenTheme";

/** One mounted Wallpaper across the new chat/first-send boundary; geometry is change-driven. */
export function useConversationWallpaper(empty: boolean, sending: boolean) {
  const settings = useButlerStore((state) => state.settings);
  const navigation = useButlerStore((state) => state.navigation);
  const chatId = useButlerStore((state) => state.activeChatId);
  const summary = useButlerStore((state) => state.summary);
  const progress = useButlerStore((state) => state.turnProgress);
  const snapshot = useMemo(() => activeTurnProgressSnapshot(summary, progress), [summary, progress]);
  const active = sending || Boolean(snapshot || (summary?.turn_state && ACTIVE_TURN_STATES.has(summary.turn_state)));
  const [contentRect, onContentRect] = useState<WallpaperContentRect>();
  const [contentRect2, onComposerRect] = useState<WallpaperContentRect>();
  const [column, onColumnRect] = useState<ConversationColumnRect>();
  const [event, setEvent] = useState<WallpaperEvent>();
  const previous = useRef<{ chatId: string; empty: boolean; active: boolean } | undefined>(undefined);
  const eventId = useRef(0);
  const power = usePowerState();
  useEffect(() => { setWallpaperHostConstrained(power.constrained); }, [power.constrained]);
  useEffect(() => {
    const last = previous.current;
    const sameChat = last?.chatId === chatId;
    const kind = empty && (!sameChat || !last?.empty) ? "newChat"
      : active && !last?.active ? "thinking"
      : sameChat && last.active && !active ? "done" : undefined;
    previous.current = { chatId, empty, active };
    if (kind) setEvent({ id: ++eventId.current, kind });
  }, [chatId, empty, active]);
  const home = useMemo(() => activeChatWallpaper(settings, navigation, chatId), [settings, navigation, chatId]);
  const source = empty ? home.source : settings.conversation_background.source;
  const columnRect = useMemo(() => !empty && column ? {
    x: column.left, y: column.top, width: column.right - column.left, height: 0,
  } : undefined, [empty, column]);
  const overlay = !empty && (source.kind === "image" || (source.kind === "live" && source.module !== "butler.riso-print"))
    ? settings.conversation_background.overlay / 100 : 0;
  const paused = settings.reduce_motion || (power.onBattery && (!empty || home.pauseOnBattery));
  const background = <Wallpaper scope="container" source={source}
    dataTestClass="new-chat-fluid-gradient conversation-wallpaper"
    motion={paused ? "paused" : empty ? home.motion : "auto"}
    pauseOnBattery={empty ? home.pauseOnBattery : true}
    contentRect={empty ? contentRect : undefined} contentRect2={contentRect2}
    columnRect={columnRect} paperOverlay={overlay} event={event} />;
  return { background, onContentRect, onColumnRect, onComposerRect };
}
