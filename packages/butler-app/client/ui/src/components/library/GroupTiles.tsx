import { appCopy } from "@/app/copy";
import { Box, FolderOpen, GroupTile, GroupTileMore, OverflowActionMenu, PencilLine, X, type GroupTilePreview } from "@/butler-ds";
import { libraryImageSource, type LibraryItem } from "../browser/libraryStore";
import { useElementDrag } from "../browser/elementDrag";
import { useCardDrag } from "./libraryCardDrag";
import { hasWebSource, safeHost } from "./libraryActions";
import type { GroupKind, LibraryGroup } from "./libraryApi";
import { useLibraryDialogs } from "./libraryDialogs";
import { startGroupDrag } from "./libraryGroupDrag";
import { openLibrary } from "./libraryNav";

export function preview(item: LibraryItem): GroupTilePreview {
  const image = libraryImageSource(item, 200);
  if (image) return { kind: "image", src: image };
  if (item.kind === "bookmark" && hasWebSource(item)) return { kind: "site", host: item.site ?? safeHost(item.url) };
  if (item.kind === "scrap") return { kind: "quote", text: item.text ?? item.title };
  return { kind: "document" };
}

/** The group a drag is over (cards or picks), for the drop ring on tiles and chips. */
export function useDropGroup() {
  const card = useCardDrag((s) => (s.target?.kind === "group" ? s.target.group : undefined));
  const pick = useElementDrag((s) => (s.target?.kind === "group" ? s.target.group : undefined));
  return card ?? pick;
}

/** One row of group tiles (`limit` cells; the last becomes “+N” when groups overflow). */
export function GroupTiles({ kind, groups, limit }: { kind: GroupKind; groups: LibraryGroup[]; limit: number }) {
  const copy = appCopy.library, words = copy.groups[kind];
  const over = groups.length > limit, shown = over ? groups.slice(0, limit - 1) : groups;
  const drop = useDropGroup();
  return <>
    {shown.map((group) => {
      const meta = [words.count(group.count), group.recent[0] ? new Date(group.updatedAt).toLocaleDateString(document.documentElement.lang) : ""].filter(Boolean).join(" · ");
      return (
        <Box key={group.id} onPointerDown={(event) => startGroupDrag(event, group)}><GroupTile dropId={group.id} name={group.name} meta={meta} label={copy.tileLabel(group.name, meta)} emptyLabel={copy.empty}
          previews={group.recent.map(preview)} drop={drop === group.id} dropHint={kind === "scrap" && useElementDrag.getState().tab ? copy.dropScrap(group.name) : copy.dropAdd(group.name)}
          onOpen={() => openLibrary({ section: kind, group: group.id })}
          menu={<OverflowActionMenu label={appCopy.browser.more} items={[
            { icon: <FolderOpen size="sm" />, label: copy.open, onSelect: () => openLibrary({ section: kind, group: group.id }) },
            { icon: <PencilLine size="sm" />, label: copy.rename, onSelect: () => useLibraryDialogs.setState({ renameGroup: group }) },
            { icon: <X size="sm" />, label: words.ungroup, variant: "destructive", onSelect: () => useLibraryDialogs.setState({ ungroup: group }) },
          ]} />} /></Box>
      );
    })}
    {over ? <GroupTileMore count={groups.length - shown.length} label={words.more(groups.length - shown.length)} meta={copy.viewAll} onOpen={() => openLibrary({ section: kind })} /> : null}
  </>;
}
