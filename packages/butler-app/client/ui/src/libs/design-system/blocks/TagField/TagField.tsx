import { useId, useState, type KeyboardEvent } from "react";
import { Plus, TagIcon } from "../../components/Icons";
import { Tag } from "../../components/Tag";
import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { cn } from "../../lib/utils";
import styles from "./TagField.module.css";

export interface TagFieldSuggestion {
  name: string;
  /** How many items carry it (shown at the end of the row). */
  count?: number;
}

export interface TagFieldProps extends DsPrivateStyleProps {
  value: readonly string[];
  onChange: (next: string[]) => void;
  /** Existing tags; the field matches them against what is typed. */
  suggestions: readonly TagFieldSuggestion[];
  /** Accessible name of the field ("Tags"). */
  label: string;
  placeholder?: string;
  removeLabel: (name: string) => string;
  /** The row that adds a new tag ("Create tag “ca”"). */
  createLabel: (name: string) => string;
  maxLength?: number;
  autoFocus?: boolean;
}

/** Case, width and compatibility forms do not split tags (NFKC, lower case). */
export const tagKey = (name: string) => name.normalize("NFKC").trim().toLocaleLowerCase();

/** Prefix matches first, then matches inside the name; each by count. At most six. */
export function matchTags(query: string, suggestions: readonly TagFieldSuggestion[], chosen: readonly string[]): TagFieldSuggestion[] {
  const key = tagKey(query);
  if (!key) return [];
  const taken = new Set(chosen.map(tagKey));
  const rank = (s: TagFieldSuggestion) => (tagKey(s.name).startsWith(key) ? 0 : 1);
  return suggestions
    .filter((s) => !taken.has(tagKey(s.name)) && tagKey(s.name).includes(key))
    .sort((a, b) => rank(a) - rank(b) || (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name))
    .slice(0, 6);
}

/**
 * Tags as removable chips inside one field, with completion from existing tags under it and a row that
 * creates a new one. Enter or a comma adds the highlighted row; Backspace on an empty field removes the last chip.
 */
export function TagField({ value, onChange, suggestions, label, placeholder, removeLabel, createLabel, maxLength = 40, autoFocus, className }: TagFieldProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const typed = query.trim().slice(0, maxLength);
  const matches = matchTags(typed, suggestions, value);
  const exact = matches.some((s) => tagKey(s.name) === tagKey(typed)) || value.some((v) => tagKey(v) === tagKey(typed));
  const options = [...matches.map((s) => ({ name: s.name, count: s.count, create: false })), ...(typed && !exact ? [{ name: typed, count: undefined, create: true }] : [])];
  const add = (name: string) => {
    if (name && !value.some((v) => tagKey(v) === tagKey(name))) onChange([...value, name]);
    setQuery(""); setActive(0);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if ((event.key === "Enter" || event.key === ",") && (options.length || typed)) {
      event.preventDefault(); add(options[active]?.name ?? typed);
    } else if (event.key === "Backspace" && !query && value.length) onChange(value.slice(0, -1));
    else if (event.key === "ArrowDown" && options.length) { event.preventDefault(); setActive((active + 1) % options.length); }
    else if (event.key === "ArrowUp" && options.length) { event.preventDefault(); setActive((active - 1 + options.length) % options.length); }
    else if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); }
  };
  return (
    <div className={cn(styles.root, className)} data-slot="tag-field">
      <div className={styles.field}>
        {value.map((name) => <Tag key={name} size="sm" onRemove={() => onChange(value.filter((v) => v !== name))} removeLabel={removeLabel(name)}>{name}</Tag>)}
        <input className={styles.input} role="combobox" aria-label={label} aria-expanded={options.length > 0} aria-controls={`${id}-list`}
          aria-activedescendant={options.length ? `${id}-${active}` : undefined} aria-autocomplete="list" value={query} placeholder={value.length ? undefined : placeholder}
          maxLength={maxLength} autoFocus={autoFocus} onChange={(event) => { setQuery(event.target.value.replace(",", "")); setActive(0); }} onKeyDown={onKeyDown} />
      </div>
      {options.length ? (
        <div className={styles.list} role="listbox" id={`${id}-list`} aria-label={label}>
          {options.map((option, index) => (
            <div key={`${option.create}-${option.name}`} id={`${id}-${index}`} role="option" aria-selected={index === active} className={styles.option}
              data-active={index === active ? "true" : undefined} data-create={option.create ? "true" : undefined}
              onPointerDown={(event) => event.preventDefault()} onClick={() => add(option.name)} onPointerMove={() => setActive(index)}>
              {option.create ? <Plus size="sm" /> : <TagIcon size="sm" />}
              <span className={styles.name}>{option.create ? createLabel(option.name) : option.name}</span>
              {option.count != null ? <span className={styles.count}>{option.count}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
