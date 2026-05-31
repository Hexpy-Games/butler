import { useState } from "react";
import { CollapsibleNavGroup } from "./CollapsibleNavGroup";
import { NavRow } from "../NavRow";
import { Folder, FileText } from "../../components/Icons";
import { Stack } from "../../components/Stack";

export function CollapsibleNavGroupFixture() {
  const [expanded, setExpanded] = useState(true);
  const [collapsedExpanded, setCollapsedExpanded] = useState(false);

  return (
    <Stack gap="2" style={{ width: "100%" }}>
      <CollapsibleNavGroup
        icon={<Folder size={17} />}
        label="Interactive Group"
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      >
        <NavRow icon={<FileText size={17} />} label="Item 1" />
        <NavRow icon={<FileText size={17} />} label="Item 2" active />
        <NavRow icon={<FileText size={17} />} label="Item 3" />
      </CollapsibleNavGroup>

      <CollapsibleNavGroup
        icon={<Folder size={17} />}
        label="Collapsed Group"
        expanded={collapsedExpanded}
        onToggle={() => setCollapsedExpanded((value) => !value)}
      >
        <NavRow icon={<FileText size={17} />} label="Hidden 1" />
        <NavRow icon={<FileText size={17} />} label="Hidden 2" />
      </CollapsibleNavGroup>
    </Stack>
  );
}
