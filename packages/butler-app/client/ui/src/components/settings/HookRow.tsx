import { appCopy, useAppLocale } from "@/app/copy.ts";
import { ButtonContainer, CardListItem, Button, PencilLine, RefreshCcw, Stack, Switch, Tooltip, Trash2, Typo } from "@/butler-ds";
import type { HookDefinition } from "./hooksTypes";

export function HookRow({ hook, busy, onToggle, onEdit, onTest, onRemove }: {
  hook: HookDefinition; busy: boolean; onToggle: (enabled: boolean) => void;
  onEdit: () => void; onTest: () => void; onRemove: () => void;
}) {
  useAppLocale();
  const copy = appCopy.settings.hooks;
  return <CardListItem title={<Typo.Body as="span" wrap="anywhere">{hook.name || hook.id}</Typo.Body>}
    meta={hook.enabled ? copy.enabled : copy.disabled}
    description={<Stack gap="xs">
      <Typo.Caption truncate>{[hook.event, hook.match.tools.join(", "), hook.command ?? hook.args?.join(" ")].filter(Boolean).join(" · ")}</Typo.Caption>
      <ButtonContainer size="icon-xs">
        <Tooltip label={busy ? appCopy.settings.saving : copy.test}><Button size="icon-xs" variant="outline" aria-label={copy.test} disabled={busy} onClick={onTest}><RefreshCcw size="sm" /></Button></Tooltip>
        <Switch aria-label={`${hook.name || hook.id}: ${copy.enabled}`} checked={hook.enabled} disabled={busy} onCheckedChange={onToggle} />
        <Tooltip label={busy ? appCopy.settings.saving : copy.edit}><Button size="icon-xs" variant="outline" aria-label={copy.edit} disabled={busy} onClick={onEdit}><PencilLine size="sm" /></Button></Tooltip>
        <Tooltip label={busy ? appCopy.settings.saving : copy.remove}><Button size="icon-xs" variant="outline" aria-label={copy.remove} disabled={busy} onClick={onRemove}><Trash2 size="sm" /></Button></Tooltip>
      </ButtonContainer>
    </Stack>} />;
}
