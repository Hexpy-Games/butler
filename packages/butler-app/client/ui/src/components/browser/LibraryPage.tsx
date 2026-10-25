import { DocumentReadingPage } from "../documents/DocumentReadingPage";
import { useState } from "react";
import { useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { Box, PageContainer, ScrollArea, Stack } from "@/butler-ds";
import { LibraryMain } from "../library/LibraryMain";
import { LibraryKindView } from "../library/LibraryKindView";
import { LibraryDetail } from "../library/LibraryDetail";
import { LibraryToolbar } from "../library/LibraryToolbar";
import { LibraryAttachDialog } from "./LibraryAttachDialog";
import type { LibraryItem } from "./libraryStore";
export function LibraryPage() {
  useAppLocale();
  const view = useButlerStore((state) => state.view);
  const [attachment, setAttachment] = useState<LibraryItem>();
  if (view.kind !== "library") return null;
  if (view.doc) return <DocumentReadingPage key={view.doc} id={view.doc} />;
  if (view.item) return <><LibraryDetail view={view} onAttach={setAttachment} /><LibraryAttachDialog item={attachment} onClose={() => setAttachment(undefined)} /></>;
  return <ScrollArea fill dataTestClass="library-page"><PageContainer width="full" gutter="xl"><Box paddingY="xl"><Stack gap="xl">
    <LibraryToolbar view={view} />
    {view.section ? <LibraryKindView key={view.section} view={view} onAttach={setAttachment} /> : <LibraryMain view={view} onAttach={setAttachment} />}
    <LibraryAttachDialog item={attachment} onClose={() => setAttachment(undefined)} />
  </Stack></Box></PageContainer></ScrollArea>;
}
