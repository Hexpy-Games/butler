import {
  cloneElement,
  isValidElement,
  type FocusEventHandler,
  type PointerEventHandler,
  type ReactElement,
  type ReactNode,
  type Ref,
  useId,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  TITLEBAR_SAFE_AREA_TOP_PX,
  clampToTitlebarSafeTop,
} from "../../lib/floatingConstraints";
import { tintedGlassSurfaceClassName } from "../../components/TintedGlass";
import styles from "./tooltip.module.css";

const TOOLTIP_DELAY_MS = 650;
const TOOLTIP_OFFSET = 8;
const TOOLTIP_FALLBACK_HEIGHT_PX = 32;
const TOOLTIP_FALLBACK_WIDTH_PX = 96;
const TOOLTIP_VIEWPORT_PADDING_PX = 12;
const WINDOW_FOCUS_TOOLTIP_SUPPRESSION_MS = 800;

interface TooltipProps {
  children: ReactNode;
  label?: string;
}

interface TooltipPosition {
  left: number;
  top: number;
}

interface TooltipTriggerProps {
  ref?: Ref<HTMLElement>;
  "aria-describedby"?: string;
  onBlur?: FocusEventHandler<HTMLElement>;
  onFocus?: FocusEventHandler<HTMLElement>;
  onPointerEnter?: PointerEventHandler<HTMLElement>;
  onPointerLeave?: PointerEventHandler<HTMLElement>;
}

export function Tooltip({ children, label }: TooltipProps) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const suppressFocusTooltipUntilRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current === null) return;
    window.clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  }, []);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const tooltipHeight =
      tooltipRef.current?.getBoundingClientRect().height ??
      TOOLTIP_FALLBACK_HEIGHT_PX;
    const tooltipWidth =
      tooltipRef.current?.getBoundingClientRect().width ??
      TOOLTIP_FALLBACK_WIDTH_PX;
    const preferredTop = rect.top - TOOLTIP_OFFSET - tooltipHeight;
    const preferredLeft = rect.left + rect.width / 2;
    const minLeft = TOOLTIP_VIEWPORT_PADDING_PX + tooltipWidth / 2;
    const maxLeft =
      window.innerWidth - TOOLTIP_VIEWPORT_PADDING_PX - tooltipWidth / 2;
    setPosition({
      left: Math.min(Math.max(preferredLeft, minLeft), maxLeft),
      top:
        preferredTop >= TITLEBAR_SAFE_AREA_TOP_PX
          ? preferredTop
          : clampToTitlebarSafeTop(rect.bottom + TOOLTIP_OFFSET),
    });
  }, []);

  const showAfterDelay = useCallback(() => {
    if (!label) return;
    clearOpenTimer();
    openTimerRef.current = window.setTimeout(() => {
      updatePosition();
      setOpen(true);
      openTimerRef.current = null;
    }, TOOLTIP_DELAY_MS);
  }, [clearOpenTimer, label, updatePosition]);

  const showImmediately = useCallback(() => {
    if (!label) return;
    clearOpenTimer();
    updatePosition();
    setOpen(true);
  }, [clearOpenTimer, label, updatePosition]);

  const showForKeyboardFocus = useCallback<FocusEventHandler<HTMLElement>>(
    (event) => {
      if (window.performance.now() < suppressFocusTooltipUntilRef.current) {
        return;
      }
      if (!event.currentTarget.matches(":focus-visible")) return;
      showImmediately();
    },
    [showImmediately],
  );

  const hide = useCallback(() => {
    clearOpenTimer();
    setOpen(false);
  }, [clearOpenTimer]);

  const suppressWindowFocusTooltip = useCallback(() => {
    suppressFocusTooltipUntilRef.current =
      window.performance.now() + WINDOW_FOCUS_TOOLTIP_SUPPRESSION_MS;
    hide();
  }, [hide]);

  useEffect(() => {
    if (!open) return undefined;
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, updatePosition]);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, label, updatePosition]);

  useEffect(() => clearOpenTimer, [clearOpenTimer]);

  useEffect(() => {
    window.addEventListener("blur", suppressWindowFocusTooltip);
    window.addEventListener("focus", suppressWindowFocusTooltip);
    document.addEventListener("visibilitychange", suppressWindowFocusTooltip);
    return () => {
      window.removeEventListener("blur", suppressWindowFocusTooltip);
      window.removeEventListener("focus", suppressWindowFocusTooltip);
      document.removeEventListener(
        "visibilitychange",
        suppressWindowFocusTooltip,
      );
    };
  }, [suppressWindowFocusTooltip]);

  const tooltip =
    open && label && position
      ? createPortal(
          <span
            className={`${tintedGlassSurfaceClassName} ${styles.tooltip}`}
            data-slot="tooltip-content"
            data-glass="popover"
            data-radius="control"
            id={tooltipId}
            ref={tooltipRef}
            role="tooltip"
            style={{
              left: position.left,
              top: position.top,
            }}
          >
            {label}
          </span>,
          document.body,
        )
      : null;

  if (isValidElement(children)) {
    const element = children as ReactElement<TooltipTriggerProps> & {
      ref?: Ref<HTMLElement>;
    };
    const existingDescription = element.props["aria-describedby"];
    const description =
      open && label
        ? [existingDescription, tooltipId].filter(Boolean).join(" ")
        : existingDescription;
    const describedChild = cloneElement(element, {
      "aria-describedby": description,
      ref: composeRefs(element.ref ?? element.props.ref, triggerRef),
      onBlur: composeEventHandlers(element.props.onBlur, hide),
      onFocus: composeEventHandlers(element.props.onFocus, showForKeyboardFocus),
      onPointerEnter: composeEventHandlers(
        element.props.onPointerEnter,
        showAfterDelay,
      ),
      onPointerLeave: composeEventHandlers(element.props.onPointerLeave, hide),
    });

    return (
      <>
        {describedChild}
        {tooltip}
      </>
    );
  }

  return (
    <span
      className={styles.wrapper}
      ref={(node) => {
        triggerRef.current = node;
      }}
      onBlur={hide}
      onFocus={showForKeyboardFocus}
      onPointerEnter={showAfterDelay}
      onPointerLeave={hide}
    >
      {children}
      {tooltip}
    </span>
  );
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  ref.current = value;
}

function composeRefs<T>(...refs: Array<Ref<T> | undefined>) {
  return (value: T | null) => {
    for (const ref of refs) assignRef(ref, value);
  };
}

function composeEventHandlers<Event extends { defaultPrevented: boolean }>(
  userHandler: ((event: Event) => void) | undefined,
  ourHandler: (event: Event) => void,
) {
  return (event: Event) => {
    userHandler?.(event);
    if (!event.defaultPrevented) ourHandler(event);
  };
}
