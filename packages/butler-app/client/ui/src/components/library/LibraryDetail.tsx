import { BlockScrap } from "./BlockScrap";
import { useEffect, useRef, useState } from "react";
import { appCopy } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import type { LibraryView } from "@/app/types";
import {
  ArtifactPreview, ArtifactPreviewFrame, ArtifactPreviewImage, Box, Button, ButtonContainer, Field, FieldLabel, Grid, Input, MessageSquarePlus,
  MetaList, PageContainer, Popup, ScrollArea, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Stack, TagField, Trash2, Typo,
} from "@/butler-ds";
import { openLibraryItem } from "../browser/LibraryItemCard";
import { deleteLibrary, librarySnapshot, type LibraryItem } from "../browser/libraryStore";
import { useLibraryGroups, useLibraryTags } from "./libraryApi";
import { fileItems, hasWebSource, itemMeta, renameItem, safeHost, tagItems } from "./libraryActions";
import { useLibraryDialogs } from "./libraryDialogs";
import { libraryParent, openLibrary, useLibraryNames } from "./libraryNav";

const NEW = "__new";

/** A scrap's detail: its HTML copy (or crop) at its own size, and its name, group, tags and source. */
export function LibraryDetail({ view, onAttach }: { view: LibraryView; onAttach: (item: LibraryItem) => void }) {
  const copy = appCopy.library;
  const item = useLibraryNames((s) => s.item);
  const [html, setHtml] = useState<{ id: string; html: string | null }>();
  const groups = useLibraryGroups("scrap");
  const tags = useLibraryTags();
  const naming = useRef(false);
  const itemId = item?.id;
  const [name, setName] = useState(item?.title ?? "");
  useEffect(() => { setName(item?.title ?? ""); }, [item?.id, item?.title]);
  useEffect(() => {
    if (!item) { goUp(view); return; }
    let active = true;
    if (item.block) return;
    void librarySnapshot(item.id).then((value) => { if (active) setHtml({ id: item.id, html: value }); }, () => { if (active) setHtml({ id: item.id, html: null }); });
    return () => { active = false; };
    // Metadata edits do not reload the saved HTML.
  }, [itemId]);
  if (!item) return null;
  const loaded = html?.id === item.id ? html : undefined;
  const setGroup = (value: string) => {
    if (value === NEW) { useLibraryDialogs.setState({ createGroup: { kind: "scrap", then: (group) => { void fileItems([item], group.id); } } }); return; }
    const group = value === "none" ? null : value;
    void fileItems([item], group);
  };
  const setTags = (next: string[]) => {
    const now = item.tags ?? [];
    void tagItems([item], next.filter((t) => !now.includes(t)), now.filter((t) => !next.includes(t)));
  };
  const commitName = () => {
    const title = name.trim();
    if (title === item.title || naming.current) return;
    naming.current = true;
    void renameItem(item, title).finally(() => { naming.current = false; setName(useLibraryNames.getState().item?.title ?? item.title); });
  };
  const remove = () => void deleteLibrary(item.id).then(() => openLibrary(libraryParent(view) ?? {}), () => notifyStatus(copy.failed, { tone: "error" }));
  return (
    <ScrollArea fill dataTestClass="library-detail"><PageContainer width="full" gutter="xl"><Box paddingY="xl">
      <Grid columns={{ compact: "1", base: "1", wide: "main-aside" }} gap="xl">
        {item.block ? <BlockScrap item={item} /> : <ArtifactPreview>
          {loaded?.html && item.snapshot ? <ArtifactPreviewFrame srcDoc={loaded.html} title={item.title} intrinsicSize={item.snapshot}
            sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" data-test-class="scrap-frame" />
            : loaded && item.crop ? <ArtifactPreviewImage src={item.crop} alt={item.title} />
              : <Typo.Caption>{loaded ? appCopy.browser.failed : appCopy.artifacts.loading}</Typo.Caption>}
        </ArtifactPreview>}
        <Stack gap="lg">
          <Field><FieldLabel htmlFor="library-item-name">{copy.name}</FieldLabel>
            <Input id="library-item-name" value={name} maxLength={200} onChange={(event) => setName(event.target.value)} onBlur={commitName}
              onKeyDown={(event) => { if (event.key === "Enter") commitName(); }} /></Field>
          <Field><FieldLabel htmlFor="library-item-group">{copy.groups.scrap.word}</FieldLabel>
            <Select value={item.group ?? "none"} onValueChange={setGroup}>
              <SelectTrigger id="library-item-group"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{copy.groups.scrap.ungrouped}</SelectItem>
                {groups.groups.map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}
                <SelectItem value={NEW}>{`${copy.groups.scrap.newGroup}…`}</SelectItem>
              </SelectContent>
            </Select></Field>
          <Field><FieldLabel>{copy.tags}</FieldLabel>
            <TagField value={item.tags ?? []} onChange={setTags} suggestions={tags.tags} label={copy.tags} placeholder={copy.addTag}
              removeLabel={copy.removeTag} createLabel={copy.createTag} /></Field>
          <MetaList items={[
            ...(hasWebSource(item) ? [{ label: copy.source, value: item.site ?? safeHost(item.url) }] : []),
            { label: copy.saved, value: itemMeta(item).split(" · ").pop() ?? "" },
            ...(item.snapshot ? [{ label: copy.size, value: `${Math.round(item.snapshot.width)} × ${Math.round(item.snapshot.height)}` }] : []),
          ]} />
          <ButtonContainer size="sm">
            {(item.block || hasWebSource(item)) && <Button size="sm" variant="outline" iconStart={<Popup size="sm" />} onClick={() => void openLibraryItem(item, true)}>{item.block ? appCopy.conversation.answerBlocks.openOriginChat : appCopy.browser.openSourcePage}</Button>}
            <Button size="sm" iconStart={<MessageSquarePlus size="sm" />} onClick={() => onAttach(item)}>{appCopy.browser.attach}</Button>
            <Button size="sm" variant="ghost" iconStart={<Trash2 size="sm" />} onClick={remove}>{copy.deleteItem}</Button>
          </ButtonContainer>
        </Stack>
      </Grid>
    </Box></PageContainer></ScrollArea>
  );
}

/** Without its item (a reload) the detail goes up one level. */
function goUp(view: LibraryView) { openLibrary(libraryParent(view) ?? {}); }
