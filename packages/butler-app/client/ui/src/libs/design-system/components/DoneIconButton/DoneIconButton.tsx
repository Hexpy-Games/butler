import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { IconButton } from "../IconButton";
import { ICON_SIZE } from "../Icons";
import { SuccessCheck } from "../SuccessCheck";
import styles from "./DoneIconButton.module.css";
import { dsClass } from "../../lib/internal";
import { cn } from "../../lib/utils";

/** How long the check stays before the action icon returns. */
export const DONE_FEEDBACK_MS = 1500;

export interface DoneIconButtonProps {
  /** Label (tooltip and accessible name) before the action. */
  label: string;
  /** Label, and the live announcement unless `announce` is false, after the action succeeds. */
  doneLabel: string;
  /** The action's icon at `size="sm"`; it morphs into a check on success. */
  icon: ReactNode;
  /**
   * Runs on click. The check shows once its result (or promise) resolves; a rejection goes to
   * `onError` and shows no check. Clicks while a promise is pending are ignored.
   */
  onAction?: (event: MouseEvent<HTMLButtonElement>) => unknown;
  /** Parent-driven done state; overrides the internal feedback state. */
  done?: boolean;
  onError?: (error: unknown) => void;
  /** Announce `doneLabel` in a polite live region (default). Pass false when the action announces its own result (a toast). */
  announce?: boolean;
  "aria-label"?: string;
}

export function DoneIconButton({
  label,
  doneLabel,
  icon,
  onAction,
  done: doneProp,
  onError,
  announce = true,
  "aria-label": ariaLabel,
}: DoneIconButtonProps) {
  const [doneState, setDoneState] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const done = doneProp ?? doneState;
  // Each false -> true mounts a new SuccessCheck, so the check draws on every success.
  const [checkRun, setCheckRun] = useState(0);
  const [wasDone, setWasDone] = useState(done);
  if (done !== wasDone) {
    setWasDone(done);
    if (done) setCheckRun((run) => run + 1);
  }

  const run = async (event: MouseEvent<HTMLButtonElement>) => {
    if (pending.current) return;
    pending.current = true;
    try {
      await onAction?.(event);
      if (!mounted.current) return;
      setDoneState(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setDoneState(false), DONE_FEEDBACK_MS);
    } catch (error) {
      onError?.(error);
    } finally {
      pending.current = false;
    }
  };

  return (
    <>
      <IconButton
        className={dsClass(styles.button)}
        data-done={done ? "true" : "false"}
        label={done ? doneLabel : label}
        aria-label={done ? doneLabel : ariaLabel ?? label}
        onClick={(event) => void run(event)}
      >
        <span className={styles.icons} aria-hidden="true">
          <span className={cn(styles.icon, styles.actionIcon)}>{icon}</span>
          <span className={cn(styles.icon, styles.checkIcon)}>
            <SuccessCheck key={checkRun} size={ICON_SIZE.sm} animate={checkRun > 0} />
          </span>
        </span>
      </IconButton>
      {announce ? (
        <span className="sr-only" role="status" aria-live="polite">
          {done ? doneLabel : ""}
        </span>
      ) : null}
    </>
  );
}
