import { useEffect, useRef } from "react";
import { Clickable } from "../../components/Clickable";
import { IconSlot } from "../../components/IconSlot";
import { CheckIcon, Square, CheckCircle2, Pencil } from "../../components/Icons";
import { Inline } from "../../components/Inline";
import { Textarea } from "../../components/Textarea";
import { Input } from "../../components/Input";
import { Stack } from "../../components/Stack";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import { dsClass } from "../../lib/internal";
import type { useQuestionPanel } from "./useQuestionPanel";
import type { QuestionPanelLabels } from "./types";
import styles from "./ComposerQuestionPanel.module.css";

export function QuestionOptions({ model: m, labels }: { model: ReturnType<typeof useQuestionPanel>; labels: QuestionPanelLabels }) {
  const active = useRef<HTMLDivElement>(null);
  useEffect(() => { const row = active.current;
    const scroll = row?.closest('[data-slot="question-options-scroll"]');
    if (row && scroll) {
      const rect = row.getBoundingClientRect();
      const frame = scroll.getBoundingClientRect();
      if (rect.top < frame.top) scroll.scrollTop -= frame.top - rect.top;
      else if (rect.bottom > frame.bottom) scroll.scrollTop += rect.bottom - frame.bottom;
    } }, [m.highlight, m.otherOpen]);
  const q = m.question;
  if (q.type === "text") return <Input aria-label={q.text} placeholder={q.placeholder} value={m.answer.text} disabled={m.busy}
    onChange={(e) => m.update({ text: e.target.value, skipped: false })} />;
  const options = [...q.options, ...(q.allowOther ? [{ label: labels.other }] : [])];
  return <Stack gap="xs" role={q.type === "multi" ? "group" : "radiogroup"} aria-label={q.text}>
    {options.map((option, index) => {
      const other = index === q.options.length;
      const selected = other ? Boolean(m.answer.other.trim()) : m.answer.selected.includes(index);
      const editing = other && m.otherOpen;
      const content = <Inline cross="start" wrap={false} grow>
        <IconSlot size="lg" minHeight="line" tone="tertiary"><Typo.Caption tone="tertiary">{index + 1}</Typo.Caption></IconSlot>
        <Stack grow minWidth="0" gap="none">
          <Inline gap="xs">{editing ? <Textarea variant="underline" textSize="label" autoFocus aria-label={labels.other} placeholder={q.placeholder ?? labels.other}
            disabled={m.busy} value={m.answer.other} onChange={(e) => m.update({ other: e.target.value, skipped: false })} />
            : <Typo.Label wrap={other ? "nowrap" : "anywhere"} truncate={other}>{other && m.answer.other ? m.answer.other : option.label}</Typo.Label>}
            {option.recommended && <Tag tone="accent">{labels.recommended}</Tag>}</Inline>
          {option.description && <Typo.Caption tone="secondary" wrap="anywhere">{option.description}</Typo.Caption>}
        </Stack>
        <IconSlot minHeight="line" tone="secondary">{other ? <Pencil size="md" aria-hidden="true" /> : q.type === "multi"
          ? selected ? <CheckCircle2 size="md" aria-hidden="true" /> : <Square size="md" aria-hidden="true" />
          : selected ? <CheckIcon size="md" aria-hidden="true" /> : null}</IconSlot>
      </Inline>;
      return <div key={index} ref={m.highlight === index ? active : undefined}>
        {editing ? <div className={styles.editingOption} data-question-option tabIndex={-1}>{content}</div> :
          <Clickable role={q.type === "multi" ? "checkbox" : "radio"} aria-checked={selected} disabled={m.busy} stretch
            data-question-option tabIndex={m.highlight === index && !m.busy ? 0 : -1} className={dsClass(styles.option)}
            data-highlighted={m.highlight === index} data-selected={selected} onClick={() => m.choose(index)}>{content}</Clickable>}
      </div>;
    })}
  </Stack>;
}
