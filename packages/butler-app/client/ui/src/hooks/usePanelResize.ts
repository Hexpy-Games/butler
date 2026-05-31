import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useState } from "react";
import { useButlerStore } from "@/app/store.ts";
import {
  DEFAULT_LEFT_PANEL_WIDTH,
  DEFAULT_RIGHT_PANEL_WIDTH,
  LEFT_PANEL_MAX_WIDTH,
  LEFT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  clampPanelWidth,
} from "@/app/panelSizing.ts";

const KEYBOARD_RESIZE_STEP = 16;

export {
  DEFAULT_LEFT_PANEL_WIDTH,
  DEFAULT_RIGHT_PANEL_WIDTH,
  LEFT_PANEL_MAX_WIDTH,
  LEFT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
};

export function usePanelResize({
  setLeftOpen,
}: {
  setLeftOpen: (value: boolean) => void;
}) {
  const leftPanelWidth = useButlerStore((state) => state.leftPanelWidth);
  const rightPanelWidth = useButlerStore((state) => state.rightPanelWidth);
  const setLeftPanelWidth = useButlerStore((state) => state.setLeftPanelWidth);
  const setRightPanelWidth = useButlerStore((state) => state.setRightPanelWidth);
  const [resizingPanel, setResizingPanel] = useState<"left" | "right" | null>(null);

  function resizeLeftPanel(nextWidth: number) {
    if (nextWidth < LEFT_PANEL_MIN_WIDTH) {
      setLeftOpen(false);
      return;
    }
    setLeftPanelWidth(
      clampPanelWidth(nextWidth, LEFT_PANEL_MIN_WIDTH, LEFT_PANEL_MAX_WIDTH),
    );
  }

  function resizeRightPanel(nextWidth: number) {
    setRightPanelWidth(
      clampPanelWidth(nextWidth, RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_WIDTH),
    );
  }

  function beginPanelResize(
    panel: "left" | "right",
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    event.preventDefault();
    const startX = event.clientX;
    const startLeftWidth = leftPanelWidth;
    const startRightWidth = rightPanelWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    setResizingPanel(panel);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function finishResize() {
      window.removeEventListener("pointermove", moveResize);
      window.removeEventListener("pointerup", finishResize);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setResizingPanel(null);
    }

    function moveResize(moveEvent: PointerEvent) {
      const delta = moveEvent.clientX - startX;
      if (panel === "left") {
        resizeLeftPanel(startLeftWidth + delta);
        if (startLeftWidth + delta < LEFT_PANEL_MIN_WIDTH) finishResize();
        return;
      }
      resizeRightPanel(startRightWidth - delta);
    }

    window.addEventListener("pointermove", moveResize);
    window.addEventListener("pointerup", finishResize, { once: true });
  }

  function handlePanelResizeKeyDown(
    panel: "left" | "right",
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (panel === "left") {
      if (event.key === "Home") {
        resizeLeftPanel(LEFT_PANEL_MIN_WIDTH);
      } else if (event.key === "End") {
        resizeLeftPanel(LEFT_PANEL_MAX_WIDTH);
      } else {
        resizeLeftPanel(
          leftPanelWidth +
            (event.key === "ArrowRight"
              ? KEYBOARD_RESIZE_STEP
              : -KEYBOARD_RESIZE_STEP),
        );
      }
      return;
    }
    if (event.key === "Home") {
      resizeRightPanel(RIGHT_PANEL_MIN_WIDTH);
    } else if (event.key === "End") {
      resizeRightPanel(RIGHT_PANEL_MAX_WIDTH);
    } else {
      resizeRightPanel(
        rightPanelWidth +
          (event.key === "ArrowLeft"
            ? KEYBOARD_RESIZE_STEP
            : -KEYBOARD_RESIZE_STEP),
      );
    }
  }

  const panelStyle = {
    "--sidebar-width": `${leftPanelWidth}px`,
    "--right-panel-width": `${rightPanelWidth}px`,
  } as CSSProperties;

  return {
    beginPanelResize,
    handlePanelResizeKeyDown,
    leftPanelWidth,
    panelStyle,
    rightPanelWidth,
    resizingPanel,
  };
}
