import { useLayoutEffect, useRef, useState, type Ref, type RefObject, type ReactNode } from "react";
import { appCopy } from "@/app/copy.ts";
import type { EpicDetail, EpicInput } from "@/app/canonApi.ts";
import { AttachmentList, Box, Clickable, IconButton, Pencil, Presence, Stack, Tooltip, Typo } from "@/butler-ds";
import { useCanonInlineUploads } from "./CanonInlineDraft.tsx";
import { epicAttachmentReferences } from "./epicAttachmentReferences.ts";
import { EpicMarkdown } from "./EpicMarkdown.tsx";
import { EpicFieldInput } from "./EpicFieldInput.tsx";
import { absoluteGatewayUrl, messageFileSource } from "@/app/messageFileUrls.ts";
import { InlineUnsavedDialog } from "./InlineUnsavedDialog.tsx";
import { useInlineExitGuard } from "./useInlineExitGuard.ts";
import { useEpicInlineEdit, type EpicTextField } from "./useEpicInlineEdit.ts";

export function EpicInlineFields({ epic, busy, onWrite, titleRef, compact = false, summary, titleAction }: {
  compact?: boolean; summary?: ReactNode; titleAction?: ReactNode;
  epic: EpicDetail; busy: boolean; titleRef?: Ref<HTMLElement>;
  onWrite: (input: EpicInput, message?: string) => Promise<boolean>;
}) {
  const edit = useEpicInlineEdit(epic, onWrite);
  const [uploads] = useCanonInlineUploads();
  busy = busy || Boolean(uploads.pendingFile);
  const save = () => busy ? Promise.resolve(false) : edit.save();
  const root = useRef<HTMLElement>(null);
  const triggers = { title: useRef<HTMLElement>(null), description: useRef<HTMLElement>(null) };
  const lastField = useRef<EpicTextField | null>(null);
  const focus = () => {
    if (edit.draft) root.current?.querySelector<HTMLElement>("input, textarea")?.focus();
    else if (lastField.current) triggers[lastField.current].current?.focus();
  };
  useLayoutEffect(() => {
    if (edit.draft) lastField.current = edit.draft.field;
    else if (lastField.current) triggers[lastField.current].current?.focus();
  }, [edit.draft]);
  const references = epicAttachmentReferences(epic.description);
  const unreferenced = (epic.attachments ?? []).filter(file => !references.has(file.file_id));
  const guard = useInlineExitGuard({ editing: Boolean(edit.draft), busy, dirty: edit.dirty || Boolean(uploads.pendingFile), save, cancel: edit.cancel, focus });
  const remountedDraft = useRef(Boolean(edit.draft));
  useLayoutEffect(() => { if (remountedDraft.current) { remountedDraft.current = false; void guard.leave(); } }, []);
  const begin = async (field: EpicTextField) => {
    if (edit.draft && !await guard.leave()) return;
    edit.begin(field);
  };
  return <>
    <Stack gap="lg" onFocus={event => { root.current = event.currentTarget; }} onBlur={event => {
      if (event.relatedTarget == null && !document.hasFocus()) return;
      const field = (event.target as HTMLElement).closest("[data-canon-inline-editor]");
      if (!edit.draft || guard.open || !field || field.contains(event.relatedTarget as Node)) return;
      if (guard.acting() || !(event.target as HTMLElement).isConnected || (event.target as HTMLButtonElement).disabled) return;
      guard.blur();
    }}>
      {(["title", "description"] as const).map(field => <Stack gap="sm" key={field}>
        <Stack align="row" cross="start" gap="lg">
          <Box grow minWidth="0">{edit.draft?.field === field
          ? <EpicFieldInput epic={epic} field={field} value={edit.draft.value} busy={busy} valid={edit.valid}
            current={edit.draft.current} base={edit.draft.base} onChange={edit.change} onSave={guard.save} onCancel={guard.cancel} />
          : <EpicFieldRest field={field} epic={epic} compact={compact} titleRef={titleRef} triggerRef={triggers[field]} busy={busy} onEdit={() => void begin(field)} />}</Box>
          {field === "title" && titleAction && <Box shrink={false}>{titleAction}</Box>}
        </Stack>
        {field === "title" && summary}
        {field === "description" && edit.draft?.field !== field && unreferenced.length > 0 && <AttachmentList
          items={unreferenced.map(file => ({ id: file.file_id, name: file.safe_name,
            href: messageFileSource(file) ? absoluteGatewayUrl(messageFileSource(file)!) : undefined }))} />}
      </Stack>)}
    </Stack>
    <InlineUnsavedDialog open={guard.open} busy={busy} valid={edit.valid} decide={guard.decide} focus={focus} />
  </>;
}

function EpicFieldRest({ field, epic, compact, busy, onEdit, titleRef, triggerRef }: {
  triggerRef: RefObject<HTMLElement | null>; field: EpicTextField; epic: EpicDetail; compact: boolean; busy: boolean; onEdit: () => void; titleRef?: Ref<HTMLElement>;
}) {
  const [hover, setHover] = useState(false), [focused, setFocused] = useState(false);
  const title = field === "title", value = epic[field];
  const Title = compact ? Typo.Body : Typo.PanelTitle;
  const label = appCopy.canon.inlineEdit[field];
  return <Tooltip label={label}><Clickable bleed="both" stretch disabled={busy} aria-label={label}
    role={title ? "button" : "group"} tabIndex={title ? 0 : -1}
    onClick={event => { if (!(event.target as HTMLElement).closest("a, button")) onEdit(); }}
    onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
    onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setFocused(false); }}>
    <Stack inline align="row" cross={title ? "center" : "start"} gap="xs" minWidth="0">
      {title ? <Title as="h3" weight={compact ? "medium" : undefined} tabIndex={-1} ref={node => {
        triggerRef.current = node?.closest<HTMLElement>('[data-slot="clickable"]') ?? null;
        if (typeof titleRef === "function") titleRef(node); else if (titleRef) titleRef.current = node;
      }} wrap="anywhere">{value}</Title>
        : <Box grow minWidth="0">{value ? <EpicMarkdown epicId={epic.id} description={value} attachments={epic.attachments} density="compact" />
          : <Typo.Caption>{appCopy.canon.descriptionPlaceholder}</Typo.Caption>}</Box>}
      {title ? <Presence present={hover || focused} motion="fade"><Box shrink={false}><Pencil size="sm" /></Box></Presence>
        : <Stack align="row" shrink={false}><IconButton label={label} disabled={busy} ref={node => { triggerRef.current = node; }}
          onClick={event => { event.stopPropagation(); onEdit(); }}>
          <Presence present={hover || focused} motion="fade"><Pencil size="sm" /></Presence>
        </IconButton></Stack>}
    </Stack>
  </Clickable></Tooltip>;
}
