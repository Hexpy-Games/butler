import { FileText, PencilLine, Sparkles, Trash2 } from "../../components/Icons";
import { IconButton } from "../../components/IconButton";
import { ButtonContainer } from "../../components/ButtonContainer";
import { CardList, CardListItem } from "./CardList";

export function CardListFixture() {
  return (
    <CardList title="Skill cards" maxVisibleRows={3}>
      <CardListItem
        icon={<Sparkles size={16} />}
        title="project-ledger"
        description="Inspect, query, render, and validate project records."
        meta="core"
      />
      <CardListItem
        icon={<FileText size={16} />}
        title="browser"
        description="Open and inspect local web targets."
        meta="user"
      />
      <CardListItem
        icon={<Sparkles size={16} />}
        title="butler-ship-feature"
        description="Run Butler work through spec, task, review, and validation."
        meta="core"
      />
      <CardListItem
        icon={<FileText size={16} />}
        title="mcp-server"
        description="Manage a connected MCP server configuration."
        meta="project"
        actions={
          <ButtonContainer size="icon-sm">
            <IconButton label="Edit">
              <PencilLine size={14} />
            </IconButton>
            <IconButton label="Delete">
              <Trash2 size={14} />
            </IconButton>
          </ButtonContainer>
        }
      />
    </CardList>
  );
}
