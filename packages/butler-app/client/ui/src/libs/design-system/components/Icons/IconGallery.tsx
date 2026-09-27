import { useEffect, useMemo, useState, type ComponentType } from "react";
import { Input } from "../Input";
import { SegmentedControl } from "../SegmentedControl";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import * as Icons from "./Icons";
import { ICON_SIZE, type IconProps, type IconSize } from "./Icons";
import styles from "./IconGallery.module.css";
import { dsClass } from "../../lib/internal";

export interface IconCatalogEntry {
  name: string;
  aliases: string[];
  Glyph: ComponentType<IconProps>;
}

/** Every exported glyph once (first export name), with the names that alias it. */
export const iconCatalog: IconCatalogEntry[] = (() => {
  const byGlyph = new Map<unknown, IconCatalogEntry>();
  for (const [name, value] of Object.entries(Icons)) {
    if (typeof value !== "function" || !/^[A-Z]/u.test(name) || name === "Icon") continue;
    const existing = byGlyph.get(value);
    if (existing) existing.aliases.push(name);
    else byGlyph.set(value, { name, aliases: [], Glyph: value as ComponentType<IconProps> });
  }
  return [...byGlyph.values()].sort((a, b) => a.name.localeCompare(b.name));
})();

const COPIED_MS = 1200;

/** Searchable grid of the DS icon set; click a tile to copy its import name. */
export function IconGallery() {
  const [query, setQuery] = useState("");
  const [size, setSize] = useState<IconSize>("md");
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(null), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return iconCatalog;
    return iconCatalog.filter((entry) =>
      [entry.name, ...entry.aliases].some((name) => name.toLowerCase().includes(needle)));
  }, [query]);

  const copy = (name: string) => {
    setCopied(name);
    void navigator.clipboard?.writeText(name).catch(() => undefined);
  };

  return (
    <Stack gap="md" data-ds-icon-gallery="">
      <div className={styles.toolbar}>
        <Input
          type="search"
          aria-label="Search icons"
          placeholder={`Search ${iconCatalog.length} icons`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <SegmentedControl
          ariaLabel="Icon size"
          size="sm"
          value={size}
          onValueChange={(value) => setSize(value as IconSize)}
          options={(Object.keys(ICON_SIZE) as IconSize[]).map((key) => ({
            value: key,
            label: <span data-icon-size={key}>{`${key} · ${ICON_SIZE[key]}`}</span>,
          }))}
        />
      </div>
      <Typo.Caption className={dsClass(styles.hint)}>
        {`${visible.length} of ${iconCatalog.length} · click an icon to copy its name`}
      </Typo.Caption>
      <div className={styles.grid}>
        {visible.map(({ name, aliases, Glyph }) => (
          <button
            key={name}
            type="button"
            className={styles.tile}
            data-icon-name={name}
            data-copied={copied === name ? "true" : undefined}
            title={aliases.length ? `${name} (also ${aliases.join(", ")})` : name}
            onClick={() => copy(name)}
          >
            <Glyph size={size} />
            <span className={styles.name}>{copied === name ? "Copied" : name}</span>
          </button>
        ))}
      </div>
    </Stack>
  );
}
