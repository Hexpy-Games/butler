import { useState, type ReactNode } from "react";
import {
  CardListItem, Clickable, Globe2, IconButton, McpServer, PencilLine, ShieldCheck, Stack, Tag, Terminal,
  Tooltip, Trash2, Typo,
} from "@/butler-ds";
import { t } from "../proposedCopy";
import type { ProposalLocale } from "../state";
import type { GrantKind, GrantRow } from "./grants";

// NEW block composition: one approved action. CardListItem (as the MCP and skill lists) with the
// kind as title, the date as meta, the exact target in monospace (one line, full text in a tooltip
// on hover and on tap/Enter it expands in place), then scope + where, and one revoke IconButton.

const ICONS: Record<GrantKind, ReactNode> = {
  command: <Terminal />, fileWrite: <PencilLine />, network: <Globe2 />, tool: <McpServer />, other: <ShieldCheck />,
};

function where(row: GrantRow, locale: ProposalLocale): string {
  if (row.scope === "always") return "";
  if (row.scope === "project") return row.project ?? "";
  return row.places.length > 1 ? t(locale, "settings.grants.conversations", { count: row.places.length }) : row.places[0] ?? "";
}

export function GrantRowView({ row, locale, busy, onRevoke }: {
  row: GrantRow; locale: ProposalLocale; busy: boolean; onRevoke: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const target = row.target || t(locale, "settings.grants.targetUnknown");
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(row.createdAt));
  const place = where(row, locale);
  return (
    <CardListItem
      data-test-class="grant-row"
      icon={ICONS[row.kind]}
      title={t(locale, `settings.grants.kind.${row.kind}`)}
      meta={date}
      description={(
        <Stack as="span" gap="xs">
          <Tooltip label={expanded ? undefined : row.target} wrap>
            <Clickable variant="text" aria-expanded={expanded} aria-label={row.target} onClick={() => setExpanded((value) => !value)}>
              <Typo.Code truncate={!expanded} wrap={expanded ? "anywhere" : undefined}>{target}</Typo.Code>
            </Clickable>
          </Tooltip>
          <Stack as="span" align="row" cross="center" gap="xs" wrap>
            <Tag size="sm" tone={row.scope === "always" ? "warning" : "neutral"}>{t(locale, `settings.grants.scope.${row.scope}`)}</Tag>
            <Typo.Caption tone="secondary" truncate>
              {[place, row.cwd ? t(locale, "settings.grants.cwd", { path: row.cwd }) : ""].filter(Boolean).join(" · ")}
            </Typo.Caption>
          </Stack>
        </Stack>
      )}
      actions={(
        <IconButton label={t(locale, "settings.grants.revoke")} disabled={busy} onClick={onRevoke}>
          <Trash2 size="sm" />
        </IconButton>
      )}
    />
  );
}
