import { Fragment, type KeyboardEvent } from "react";
import { appCopy } from "@/app/copy";
import type { ProjectFolderSelection } from "@/app/api";
import {
  Breadcrumb, BreadcrumbButton, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
  Button, ButtonContainer, DialogForm, EmptyLine, FieldError, Folder,
  LoadingIndicator, NavRow, Reply, ScrollArea, Stack, Tooltip,
} from "@/butler-ds";
import { useProjectFolderBrowser } from "./useProjectFolderBrowser";

type Props = { initialPath: string; onBack: () => void; onSelect: (folder: ProjectFolderSelection) => void };

export function ProjectFolderBrowser({ initialPath, onBack, onSelect }: Props) {
  const browser = useProjectFolderBrowser(initialPath);
  const { page, loading, error } = browser;
  const segments = page?.path ? page.path.split("/") : [];
  const choose = () => {
    if (!page?.path || loading || error) return;
    onSelect({ workspace_path: page.path, folder_path: `${page.root_name}/${page.path}`,
      display_name: segments.at(-1) });
  };
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-test-class="project-folder-up"], [data-test-class="project-folder-row"]')];
    const index = rows.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    if (event.key === "Backspace" || (event.altKey && event.key === "ArrowUp")) { event.preventDefault(); browser.parent(); return; }
    const next = { ArrowUp: Math.max(0, index - 1), ArrowDown: Math.min(rows.length - 1, index + 1),
      Home: 0, End: rows.length - 1 }[event.key];
    if (next !== undefined) { event.preventDefault(); rows[next]?.focus(); }
  }
  return (
    <DialogForm title={appCopy.sidebar.chooseProjectFolder} busy={loading} onSubmit={choose}
      footer={<ButtonContainer size="default" justify="end">
        <Button type="button" variant="outline" onClick={onBack}>{appCopy.common.back}</Button>
        <Tooltip label={!page?.path ? appCopy.sidebar.openSubfolderFirst : undefined}>
          <Button ref={browser.useRefButton} type="submit" disabled={!page?.path || loading || error}>
            {appCopy.sidebar.useThisFolder}
          </Button>
        </Tooltip>
      </ButtonContainer>}>
      {page && <Breadcrumb label={appCopy.sidebar.folderPathLabel}>
        <BreadcrumbList>
          {[page.root_name, ...segments].map((name, index) => <Fragment key={index}>
            {index > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>{index === segments.length ? <BreadcrumbPage>{name}</BreadcrumbPage>
              : <BreadcrumbButton disabled={loading} onClick={() => void browser.navigate(segments.slice(0, index).join("/"))}>
                  {name}
                </BreadcrumbButton>}</BreadcrumbItem>
          </Fragment>)}
        </BreadcrumbList>
      </Breadcrumb>}
      {loading && <LoadingIndicator state="loading" />}
      {error && <FieldError>{appCopy.sidebar.foldersLoadFailed}</FieldError>}
      <ScrollArea scrollRef={browser.scrollRef} maxHeight="sm" minHeight="xs" dataTestClass="project-folder-scroll">
        <Stack gap="none" role="group" aria-label={appCopy.sidebar.subfoldersLabel} onKeyDown={onKeyDown}>
          {!error && page?.path && <NavRow icon={<Reply />} label={appCopy.sidebar.parentFolder}
            disabled={loading} dataTestClass="project-folder-up" onClick={browser.parent} />}
          {!error && !loading && page?.folders.length === 0 && <Stack tabIndex={-1} data-test-class="project-folder-empty"><EmptyLine icon={<Folder />} message={appCopy.sidebar.noSubfolders} /></Stack>}
          {!error && page?.folders.map(({ name }) => <NavRow key={name} icon={<Folder />} label={name}
            disabled={loading} dataTestClass="project-folder-row"
            onClick={() => void browser.navigate([...segments, name].join("/"))} />)}
          {page?.next_after && <Button type="button" variant="ghost" disabled={loading}
            onClick={() => void browser.navigate(page.path, page)}>{appCopy.sidebar.showMoreFolders}</Button>}
        </Stack>
      </ScrollArea>
    </DialogForm>
  );
}
