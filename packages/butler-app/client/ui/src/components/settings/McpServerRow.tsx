import { appCopy } from "@/app/copy.ts";
import type { McpServerView } from "@/app/types.ts";
import {
  Button,
  ButtonContainer,
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
}: {
  server: McpServerView;
  onProbe: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const copy = appCopy.settings;
  const toggleLabel = server.enabled
    ? copy.actions.disableMcpServer
    : copy.actions.enableMcpServer;
  return (
    <CardListItem
      title={server.display_name}
      description={mcpServerSubtitle(server)}
      meta={toggleLabel}
      actions={
        <ButtonContainer size="xs">
          <Button
            type="button"
            size="xs"
            variant="outline"
            aria-label={copy.actions.testMcpServer}
            onClick={onProbe}
          >
            <RefreshCcw size={13} />
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={onToggle}>
            {toggleLabel}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            aria-label={copy.actions.editMcpServer}
            onClick={onEdit}
          >
            <PencilLine size={13} />
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            aria-label={copy.actions.deleteMcpServer}
            onClick={onRemove}
          >
            <Trash2 size={13} />
          </Button>
        </ButtonContainer>
      }
    />
  );
}
