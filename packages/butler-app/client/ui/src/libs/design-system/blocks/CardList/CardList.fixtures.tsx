import { FileText, PencilLine, Sparkles, Trash2 } from "../../components/Icons";
import { IconButton } from "../../components/IconButton";
import { ButtonContainer } from "../../components/ButtonContainer";
import { CardList, CardListItem } from "./CardList";

export function CardListFixture() {
  return (
    <CardList title="Skill cards" maxVisibleRows={3}>
      <CardListItem
        icon={<Sparkles size="md" />}
        title="project-ledger"
        description="Inspect, query, render, and validate project records."
        meta="core"
      />
      <CardListItem
        icon={<FileText size="md" />}
        title="browser"
        description="Open and inspect local web targets."
        meta="user"
      />
      <CardListItem
        icon={<Sparkles size="md" />}
        title="butler-ship-feature"
        description="Run Butler work through spec, task, review, and validation."
        meta="core"
      />
      <CardListItem
        icon={<FileText size="md" />}
        title="mcp-server"
        description="Manage a connected MCP server configuration."
        meta="project"
        actions={
          <ButtonContainer size="icon-sm">
            <IconButton label="Edit">
              <PencilLine size="sm" />
            </IconButton>
            <IconButton label="Delete">
              <Trash2 size="sm" />
            </IconButton>
          </ButtonContainer>
        }
      />
    </CardList>
  );
}
