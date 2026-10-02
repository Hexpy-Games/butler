import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { McpServerView } from "@/app/types.ts";
import {
  Button,
  ButtonContainer, Switch,
  CardListItem,
  PencilLine,
  RefreshCcw,
  Trash2,
} from "@/butler-ds";
import { mcpServerSubtitle } from "./mcpSettingsUtils";

export function McpServerRow({
  server,
  onProbe,
  onToggle,
  onEdit,
  onRemove,
  busy,
}: {
  server: McpServerView;
  busy: boolean;
  onProbe: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  useAppLocale();
  const copy = appCopy.settings;
  const toggleLabel = server.enabled
    ? copy.actions.disableMcpServer
    : copy.actions.enableMcpServer;
  return (
    <CardListItem
      title={server.display_name}
      description={mcpServerSubtitle(server)}
      meta={server.enabled ? copy.mcpEnabled : copy.mcpDisabled}
      actions={
        <ButtonContainer size="xs">
          <Button
            disabled={busy}
            type="button"
            size="xs"
            variant="outline"
            aria-label={copy.actions.testMcpServer}
            onClick={onProbe}
          >
            <RefreshCcw size="sm" />
          </Button>
          <Switch checked={server.enabled} disabled={busy}
            aria-label={`${server.display_name}: ${toggleLabel}`} onCheckedChange={onToggle} />
          <Button
            disabled={busy}
            type="button"
            size="xs"
            variant="outline"
            aria-label={copy.actions.editMcpServer}
            onClick={onEdit}
          >
            <PencilLine size="sm" />
          </Button>
          <Button
            disabled={busy}
            type="button"
            size="xs"
            variant="outline"
            aria-label={copy.actions.deleteMcpServer}
            onClick={onRemove}
          >
            <Trash2 size="sm" />
          </Button>
        </ButtonContainer>
      }
    />
  );
}
