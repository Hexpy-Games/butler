// TimePicker: a segmented time field (one spinbutton per segment, digits and arrows, the openstatus/shadcn
// pattern) in the Input/Select field look, plus a Popover of wheel columns for pointer and touch.
// The value is "HH:MM" (24 h); the locale sets the hour cycle, segment order and day-period words.
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { IconButton } from "../IconButton";
import { Clock3 } from "../Icons";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "../Popover";
import { TimeColumns } from "./TimeColumns";
import {
  dayPeriods, formatTime, hour12, isPm, localeHourCycle, pad, parseTime, segmentLayout, segmentNames, stepSegment, typeDigit,
  type HourCycle, type Segment, type TimeParts,
} from "./timeModel";
import styles from "./TimePicker.module.css";

export interface TimePickerProps {
  id?: string;
  /** "HH:MM", 24-hour. */
  value: string;
  onValueChange: (value: string) => void;
  /** BCP 47 locale; sets 12/24-hour (Intl hourCycle), the day-period words and the segment order. Default: the document language. */
  locale?: string;
  /** Overrides the locale's hour cycle. */
  hourCycle?: HourCycle;
  /** Minute column step in the popover (typed minutes stay free). */
  minuteStep?: number;
  disabled?: boolean;
  /** Accessible name of the whole field (the visible label's text). */
  "aria-label"?: string;
  "aria-describedby"?: string;
  /** Localized name of the clock button, e.g. "시간 고르기" / "Choose time". */
  pickerLabel: string;
  /** Documentation and tests: start with the popover open. */
  defaultOpen?: boolean;
}

export function TimePicker({
  id, value, onValueChange, locale, hourCycle, minuteStep = 5, disabled, pickerLabel, defaultOpen = false, ...aria
}: TimePickerProps) {
  const lang = locale ?? (typeof document === "undefined" ? "en-US" : document.documentElement.lang || "en-US");
  const cycle = hourCycle ?? localeHourCycle(lang);
  const { order, separator } = useMemo(() => segmentLayout(lang, cycle), [lang, cycle]);
  const periods = useMemo(() => dayPeriods(lang), [lang]);
  const names = useMemo(() => segmentNames(lang), [lang]);
  const parts = parseTime(value);
  const [open, setOpen] = useState(defaultOpen);
  const [pending, setPending] = useState("");
  const returnFocus = useRef(false);
  const refs = useRef<Partial<Record<Segment, HTMLSpanElement | null>>>({});
  const set = (next: TimeParts) => { if (formatTime(next) !== value) onValueChange(formatTime(next)); };
  const focusSegment = (segment: Segment | undefined) => segment && refs.current[segment]?.focus();
  const display: Record<Segment, string> = {
    period: periods[isPm(parts) ? 1 : 0], hour: pad(cycle === "h12" ? hour12(parts.hours) : parts.hours), minute: pad(parts.minutes),
  };
  const range: Record<Segment, [number, number, number]> = {
    period: [0, 1, isPm(parts) ? 1 : 0], hour: cycle === "h12" ? [1, 12, hour12(parts.hours)] : [0, 23, parts.hours], minute: [0, 59, parts.minutes],
  };

  const onKeyDown = (segment: Segment, event: KeyboardEvent<HTMLSpanElement>) => {
    const index = order.indexOf(segment);
    const key = event.key;
    if ((key === "ArrowDown" && event.altKey) || key === "Enter") { setOpen(true); }
    else if (key === "ArrowUp" || key === "ArrowDown") { setPending(""); set(stepSegment(segment, cycle, parts, key === "ArrowUp" ? 1 : -1)); }
    else if (key === "ArrowRight") focusSegment(order[index + 1]);
    else if (key === "ArrowLeft") focusSegment(order[index - 1]);
    else if (key === "Home" || key === "End") set(homeEnd(segment, key === "Home"));
    else if (key === "Backspace" || key === "Delete") setPending("");
    else if (segment === "period" && /^[a-z]$/i.test(key)) {
      const pm = periods[1].toLowerCase().startsWith(key.toLowerCase()) || key.toLowerCase() === "p";
      const am = periods[0].toLowerCase().startsWith(key.toLowerCase()) || key.toLowerCase() === "a";
      if (pm !== am) set({ ...parts, hours: (parts.hours % 12) + (pm ? 12 : 0) });
    } else if (segment !== "period" && /^\d$/.test(key)) {
      const result = typeDigit(segment, cycle, parts, pending, Number(key));
      set(result.parts);
      setPending(result.pending);
      if (result.advance) focusSegment(order[index + 1]);
    } else return;
    event.preventDefault();
  };
  const homeEnd = (segment: Segment, home: boolean): TimeParts => segment === "minute" ? { ...parts, minutes: home ? 0 : 59 }
    : segment === "period" ? { ...parts, hours: (parts.hours % 12) + (home ? 0 : 12) }
      : cycle === "h12" ? { ...parts, hours: (home ? 1 : 12) % 12 + (isPm(parts) ? 12 : 0) } : { ...parts, hours: home ? 0 : 23 };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div role="group" id={id} aria-label={aria["aria-label"]} aria-describedby={aria["aria-describedby"]}
          className={styles.field} data-slot="time-picker" data-disabled={disabled ? "" : undefined} data-open={open ? "" : undefined}>
          <span className={styles.segments} lang={lang}>
            {order.map((segment, index) => (
              <span key={segment} className={styles.segmentWrap}>
                {segment === "minute" && order[index - 1] === "hour" ? <span className={styles.separator} aria-hidden="true">{separator}</span> : null}
                <span ref={(node) => { refs.current[segment] = node; }} role="spinbutton" tabIndex={disabled ? -1 : 0} inputMode="numeric"
                  aria-label={names[segment]} aria-valuemin={range[segment][0]} aria-valuemax={range[segment][1]} aria-valuenow={range[segment][2]}
                  aria-valuetext={display[segment]} aria-disabled={disabled || undefined} className={styles.segment} data-segment={segment}
                  onKeyDown={disabled ? undefined : (event) => onKeyDown(segment, event)} onBlur={() => setPending("")}>
                  {display[segment]}
                </span>
              </span>
            ))}
          </span>
          <PopoverTrigger asChild>
            <IconButton label={pickerLabel} disabled={disabled} aria-haspopup="dialog" aria-expanded={open}><Clock3 size="md" /></IconButton>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" width="anchor" aria-label={pickerLabel} onEscapeKeyDown={() => { returnFocus.current = true; }}
        onCloseAutoFocus={(event) => {
          // Enter and Escape hand focus back to the field; a tap elsewhere leaves focus where it went.
          event.preventDefault();
          if (returnFocus.current) focusSegment("hour");
          returnFocus.current = false;
        }}>
        <TimeColumns parts={parts} cycle={cycle} order={order} periods={periods} names={names} minuteStep={minuteStep}
          onChange={set} onDone={() => { returnFocus.current = true; setOpen(false); }} />
      </PopoverContent>
    </Popover>
  );
}
