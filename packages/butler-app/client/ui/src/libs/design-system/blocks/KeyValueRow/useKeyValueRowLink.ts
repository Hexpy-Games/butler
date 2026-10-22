import { useId, type FocusEvent, type HTMLAttributes, type PointerEvent } from "react";

type LinkHandlers = Pick<HTMLAttributes<HTMLDivElement>, "onPointerEnter" | "onPointerLeave" | "onFocus" | "onBlur">;

interface LinkRowProps extends LinkHandlers {
  role: "group";
  "aria-labelledby": string;
  tabIndex: number;
  "data-linked": "true";
}

export interface KeyValueRowLink {
  /** Spread on the row; undefined when the row is not linked. */
  rowProps?: LinkRowProps;
  labelId?: string;
  valueId?: string;
}

/**
 * Links a KeyValueRow to a chart as its legend. The row becomes one tab stop,
 * a group named by its label and value. Mouse hover and keyboard focus
 * (:focus-visible) report true; their end reports false. A click focuses the
 * row without :focus-visible, so leaving it with the pointer still clears the
 * highlight. The caller's own handlers run first.
 */
export function useKeyValueRowLink(
  onHighlightChange: ((highlighted: boolean) => void) | undefined,
  { onPointerEnter, onPointerLeave, onFocus, onBlur, tabIndex }: LinkHandlers & { tabIndex?: number },
): KeyValueRowLink {
  const id = useId();
  if (!onHighlightChange) return {};
  const labelId = `${id}-label`;
  const valueId = `${id}-value`;
  return {
    labelId,
    valueId,
    rowProps: {
      role: "group",
      "aria-labelledby": `${labelId} ${valueId}`,
      tabIndex: tabIndex ?? 0,
      "data-linked": "true",
      onPointerEnter: (event: PointerEvent<HTMLDivElement>) => {
        onPointerEnter?.(event);
        if (event.pointerType === "mouse") onHighlightChange(true);
      },
      onPointerLeave: (event: PointerEvent<HTMLDivElement>) => {
        onPointerLeave?.(event);
        if (event.pointerType === "mouse" && !event.currentTarget.matches(":focus-visible")) onHighlightChange(false);
      },
      onFocus: (event: FocusEvent<HTMLDivElement>) => {
        onFocus?.(event);
        if (event.currentTarget.matches(":focus-visible")) onHighlightChange(true);
      },
      onBlur: (event: FocusEvent<HTMLDivElement>) => {
        onBlur?.(event);
        if (!event.currentTarget.matches(":hover")) onHighlightChange(false);
      },
    },
  };
}
