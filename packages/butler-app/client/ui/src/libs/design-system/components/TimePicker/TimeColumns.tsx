// The TimePicker popover body: one wheel column per segment. Every column keeps its
// selected value on the same centered row (scroll-snap; scrollTop set from the row index, never measured
// from transformed boxes, so the Popover's open motion cannot skew it).
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { hour12, isPm, pad, withHour12, type HourCycle, type Segment, type TimeParts } from "./timeModel";
import styles from "./TimePicker.module.css";

interface Option { value: number; label: string }

export interface TimeColumnsProps {
  parts: TimeParts;
  cycle: HourCycle;
  order: Segment[];
  periods: [string, string];
  names: Record<Segment, string>;
  minuteStep: number;
  onChange: (parts: TimeParts) => void;
  /** Enter, or a tap on a minute: close and return focus to the field. */
  onDone: () => void;
}

function columnOptions(segment: Segment, cycle: HourCycle, periods: [string, string], minuteStep: number, minutes: number): Option[] {
  if (segment === "period") return periods.map((label, value) => ({ value, label }));
  if (segment === "hour") {
    return cycle === "h12" ? Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: pad(i + 1) }))
      : Array.from({ length: 24 }, (_, i) => ({ value: i, label: pad(i) }));
  }
  const values = Array.from({ length: Math.ceil(60 / minuteStep) }, (_, i) => i * minuteStep);
  if (!values.includes(minutes)) values.push(minutes);
  return values.sort((a, b) => a - b).map((value) => ({ value, label: pad(value) }));
}

const selectedValue = (segment: Segment, cycle: HourCycle, parts: TimeParts) =>
  segment === "period" ? (isPm(parts) ? 1 : 0) : segment === "minute" ? parts.minutes : cycle === "h12" ? hour12(parts.hours) : parts.hours;

function apply(segment: Segment, cycle: HourCycle, parts: TimeParts, value: number): TimeParts {
  if (segment === "period") return withHour12(parts, hour12(parts.hours), value === 1);
  if (segment === "minute") return { ...parts, minutes: value };
  return cycle === "h12" ? withHour12(parts, value) : { ...parts, hours: value };
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Puts option `index` on the center row: the viewport pads two rows above and below, so scrollTop is index × row height. */
function center(wheel: HTMLElement | null, index: number, smooth = false) {
  const row = wheel?.querySelector<HTMLElement>("[role='option']")?.offsetHeight;
  if (!wheel || !row || index < 0) return;
  const top = index * row;
  if (smooth && !reducedMotion()) wheel.scrollTo({ top, behavior: "smooth" });
  else wheel.scrollTop = top;
}

function Column({ segment, options, selected, name, onPick, onKeyDown }: {
  segment: Segment; options: Option[]; selected: number; name: string;
  onPick: (value: number, viaTap: boolean) => void; onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const wheel = useRef<HTMLDivElement>(null);
  const settle = useRef<number | undefined>(undefined);
  const index = options.findIndex((option) => option.value === selected);
  // Center on mount and on every change, after layout; again once fonts are ready (row height can change).
  useLayoutEffect(() => { center(wheel.current, index); }, [index]);
  useEffect(() => { void document.fonts?.ready.then(() => center(wheel.current, index)); }, [index]);
  // A swipe or wheel scroll picks the row it settles on (iOS-wheel behaviour).
  const onScroll = () => {
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      const node = wheel.current;
      const row = node?.querySelector<HTMLElement>("[role='option']")?.offsetHeight;
      if (!node || !row) return;
      const next = options[Math.max(0, Math.min(options.length - 1, Math.round(node.scrollTop / row)))];
      if (next && next.value !== selected) onPick(next.value, false);
    }, 140);
  };
  return (
    <div className={styles.column} data-time-column={segment}>
      <span className={styles.columnName} aria-hidden="true">{name}</span>
      <div ref={wheel} role="listbox" aria-label={name} className={styles.wheel} onScroll={onScroll} onKeyDown={onKeyDown}>
        {options.map((option) => (
          <div key={option.value} role="option" aria-selected={option.value === selected} data-value={option.value}
            tabIndex={option.value === selected ? 0 : -1} className={styles.option}
            onClick={() => { onPick(option.value, true); center(wheel.current, options.indexOf(option), true); }}>
            {option.label}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TimeColumns({ parts, cycle, order, periods, names, minuteStep, onChange, onDone }: TimeColumnsProps) {
  const root = useRef<HTMLDivElement>(null);
  const focusSelected = (segment: Segment | undefined) =>
    root.current?.querySelector<HTMLElement>(`[data-time-column='${segment}'] [aria-selected='true']`)?.focus({ preventScroll: true });
  useEffect(() => {
    const frame = requestAnimationFrame(() => focusSelected("hour"));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div ref={root} className={styles.columns} data-columns={order.length}>
      {order.map((segment) => {
        const options = columnOptions(segment, cycle, periods, minuteStep, parts.minutes);
        const selected = selectedValue(segment, cycle, parts);
        const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
          const index = options.findIndex((option) => option.value === selected);
          const column = order.indexOf(segment);
          const move = (next: number) => {
            onChange(apply(segment, cycle, parts, options[Math.max(0, Math.min(options.length - 1, next))]!.value));
            requestAnimationFrame(() => focusSelected(segment));
          };
          if (event.key === "ArrowDown") move(index + 1);
          else if (event.key === "ArrowUp") move(index - 1);
          else if (event.key === "Home") move(0);
          else if (event.key === "End") move(options.length - 1);
          else if (event.key === "ArrowRight" && column < order.length - 1) focusSelected(order[column + 1]);
          else if (event.key === "ArrowLeft" && column > 0) focusSelected(order[column - 1]);
          else if (event.key === "Enter" || event.key === " ") onDone();
          else return;
          event.preventDefault();
        };
        return <Column key={segment} segment={segment} options={options} selected={selected} name={names[segment]}
          onKeyDown={onKeyDown} onPick={(value, viaTap) => {
            onChange(apply(segment, cycle, parts, value));
            if (viaTap && segment === "minute") onDone();
          }} />;
      })}
    </div>
  );
}
