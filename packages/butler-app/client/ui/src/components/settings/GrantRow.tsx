import { useState, type ReactNode } from "react";
import { appCopy } from "@/app/copy.ts";
import {
  CardListItem, Clickable, Globe2, IconButton, McpServer, PencilLine, ShieldCheck, Stack,
  Tag, Terminal, Tooltip, Trash2, Typo,
} from "@/butler-ds";
import type { GrantedRow, GrantKind } from "./grantRows";

const ICONS: Record<GrantKind, ReactNode> = {
  command: <Terminal />, fileWrite: <PencilLine />, network: <Globe2 />, tool: <McpServer />, other: <ShieldCheck />,
};

function where(row: GrantedRow): string {
  const copy = appCopy.settings.grants;
  if (row.scope === "always") return "";
  if (row.scope === "project") return row.project ?? "";
  if (row.places.size > 1) return copy.conversations(row.places.size);
  return [...row.places.values()][0] || copy.deletedChat;
}

export function GrantRow({ row, dateFormatter, busy, onRevoke }: {
  row: GrantedRow; dateFormatter: Intl.DateTimeFormat; busy: boolean; onRevoke: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const copy = appCopy.settings.grants;
  const target = row.target || copy.targetUnknown;
  const preview = target.split("\n")[0];
  const date = dateFormatter.format(new Date(row.createdAt));
  return (
    <CardListItem data-test-class="grant-row" icon={ICONS[row.kind]} title={copy.kind[row.kind]} meta={date}
      description={(
        <Stack as="span" gap="xs">
          <Tooltip label={expanded ? undefined : target} wrap>
            <Clickable variant="text" aria-expanded={expanded} aria-label={target} onClick={() => setExpanded(value => !value)}>
              <Typo.Code truncate={!expanded} wrap={expanded ? "anywhere" : undefined}>{expanded ? target : preview}</Typo.Code>
            </Clickable>
          </Tooltip>
          <Stack as="span" align="row" cross="center" gap="xs" wrap>
            <Tag size="sm" tone={row.scope === "always" ? "warning" : "neutral"}>{copy.scope[row.scope]}</Tag>
            <Typo.Caption tone="secondary" truncate>
              {[where(row), row.cwd ? copy.cwd(row.cwd) : ""].filter(Boolean).join(" · ")}
            </Typo.Caption>
          </Stack>
        </Stack>
      )}
      actions={<IconButton label={copy.revoke} disabled={busy} onClick={onRevoke}><Trash2 size="sm" /></IconButton>}
    />
  );
}
