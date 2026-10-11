import { appCopy } from "@/app/copy";
import { Inline, OverflowActionMenu, PencilLine, PillButton, Plus, X } from "@/butler-ds";
import type { GroupKind, LibraryGroups } from "./libraryApi";
import { useDropGroup } from "./GroupTiles";
import { useLibraryDialogs } from "./libraryDialogs";
import { openLibrary } from "./libraryNav";
import { startGroupDrag } from "./libraryGroupDrag";

export function GroupChips({ kind, groups, selected }: { kind: GroupKind; groups: LibraryGroups; selected?: string }) {
  const copy = appCopy.library, words = copy.groups[kind];
  const drop = useDropGroup();
  const group = groups.groups.find((group) => group.id === selected);
  return <Inline gap="xs" wrap cross="center" data-test-class="library-group-chips">
    <PillButton pressed={!selected} count={groups.total} onClick={() => openLibrary({ section: kind })}>{copy.kinds.all}</PillButton>
    {groups.groups.map((group) => <PillButton key={group.id} pressed={selected === group.id} count={group.count} drop={drop === group.id}
      data-group-chip={group.id} onPointerDown={(event) => startGroupDrag(event, group)} onClick={() => openLibrary({ section: kind, group: group.id })}>{group.name}</PillButton>)}
    <PillButton pressed={selected === "none"} count={groups.ungrouped} onClick={() => openLibrary({ section: kind, group: "none" })}>{words.ungrouped}</PillButton>
    <PillButton icon={<Plus size="sm" />} onClick={() => useLibraryDialogs.setState({ createGroup: { kind } })}>{words.newGroup}</PillButton>
    {group ? <OverflowActionMenu label={appCopy.browser.more} items={[
      { icon: <PencilLine size="sm" />, label: copy.rename, onSelect: () => useLibraryDialogs.setState({ renameGroup: group }) },
      { icon: <X size="sm" />, label: words.ungroup, variant: "destructive", onSelect: () => useLibraryDialogs.setState({ ungroup: group }) },
    ]} /> : null}
  </Inline>;
}
