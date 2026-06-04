import type { ReactNode } from "react";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import { RowActionCluster } from "../RowActionCluster";
import styles from "./WorkerActivityRow.module.css";

const PHASES = [
  "orienting",
  "planning",
  "inspecting",
  "executing",
  "verifying",
  "committing",
  "reporting",
] as const;

type WorkerPhase =
  | (typeof PHASES)[number]
  | "consolidating"
  | "complete"
  | "blocked"
  | "failed"
  | "cancelled"
  | "recoverable"
  | string;

export interface WorkerActivityRowProps {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode[];
  details?: ReactNode;
  phase?: WorkerPhase;
  showPhaseRail?: boolean;
  compact?: boolean;
  depth?: number;
  expanded?: boolean;
  controlsId?: string;
  onToggle?: () => void;
}

export function WorkerActivityRow({
  id,
  title,
  description,
  meta,
  icon,
  actions = [],
  details,
  phase,
  showPhaseRail = true,
  compact = false,
  depth = 0,
  expanded,
  controlsId,
  onToggle,
}: WorkerActivityRowProps) {
  const currentPhase = phaseIndex(phase);
  const terminal = isTerminalPhase(phase);
  const hasIcon = Boolean(icon);
  const heading = (
    <span className={styles.primaryLine}>
      <Typo.Body as="span" className={styles.title} data-slot="activity-feed-title">{title}</Typo.Body>
      {meta ? (
        <Typo.Caption className={styles.meta} data-slot="activity-feed-meta">
          {meta}{description ? ":" : null}
        </Typo.Caption>
      ) : null}
      {description ? (
        <Typo.Caption
          className={styles.description}
          data-slot="activity-feed-description"
        >
          {description}
        </Typo.Caption>
      ) : null}
    </span>
  );
  return (
    <article
      className={cn(styles.root, compact && styles.compact, !hasIcon && styles.noIcon)}
      data-depth={depth > 0 ? String(depth) : undefined}
      data-terminal={terminal ? "true" : undefined}
      data-worker-phase={phase}
      id={id}
    >
      {icon ? <span className={styles.icon} data-slot="activity-feed-icon">{icon}</span> : null}
      <div className={styles.body}>
        <div className={styles.header}>
          {onToggle ? (
            <button
              aria-controls={controlsId}
              aria-expanded={expanded}
              className={styles.headerButton}
              type="button"
              onClick={onToggle}
            >
              {heading}
            </button>
          ) : heading}
          {actions.length > 0 ? (
            <span className={styles.actions}>
              <RowActionCluster>{actions}</RowActionCluster>
            </span>
          ) : null}
        </div>
        {showPhaseRail && phase ? (
          <ol className={styles.phaseRail} aria-label="Worker phase">
            {PHASES.map((item, index) => (
              <li
                className={styles.phaseStep}
                data-state={phaseState(index, currentPhase, terminal, phase)}
                key={item}
              >
                <span className={styles.phaseDot} aria-hidden="true" />
                <span className={styles.phaseLabel}>{phaseTitle(item)}</span>
              </li>
            ))}
          </ol>
        ) : null}
        {details ? <div className={styles.details}>{details}</div> : null}
      </div>
    </article>
  );
}

function phaseIndex(phase?: WorkerPhase): number {
  if (phase === "consolidating") return PHASES.indexOf("verifying");
  if (phase === "complete") return PHASES.length;
  return PHASES.findIndex((item) => item === phase);
}

function isTerminalPhase(phase?: WorkerPhase): boolean {
  return phase === "complete" || phase === "failed" || phase === "cancelled";
}

function phaseState(
  index: number,
  current: number,
  terminal: boolean,
  phase?: WorkerPhase,
): string {
  if ((phase === "failed" || phase === "cancelled") && index === Math.max(0, current)) {
    return phase;
  }
  if (terminal && current >= PHASES.length) return "done";
  if (current < 0) return "pending";
  if (index < current) return "done";
  if (index === current) return "active";
  return "pending";
}

function phaseTitle(phase: (typeof PHASES)[number]): string {
  if (phase === "orienting") return "Orient";
  if (phase === "planning") return "Plan";
  const titles: Record<string, string> = { orienting: "Orient", planning: "Plan", executing: "Execute", verifying: "Verify" };
  return titles[phase] ?? "Report";
}
