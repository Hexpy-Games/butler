import { useEffect } from "react";
import { appCopy } from "@/app/copy.ts";
import { Box, Card, IconButton, Stack, Typo, X, type AsideLayout } from "@/butler-ds";
import { ErrorBoundary } from "@/components/common/ErrorBoundary.tsx";
import { EpicInspector } from "./EpicInspector.tsx";
import { useCanonSelection } from "./useCanonSelection.ts";

/** The DS owns aside placement, scrolling and presence motion. */
export function CanonAside({ projectId, epicId, layout }: { projectId: string; epicId: string; layout: AsideLayout }) {
  const { select } = useCanonSelection(projectId);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Let nested fields, menus and popovers consume Escape before dismissing the page detail.
      queueMicrotask(() => {
        if (event.defaultPrevented || document.querySelector('[role="alertdialog"], [role="dialog"]')) return;
        void select(null);
      });
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [select]);
  const content = <Box padding="md"><Stack gap="lg">
    <Stack align="row" cross="center" justify="between" gap="sm">
      <Typo.PanelTitle>{appCopy.canon.epic}</Typo.PanelTitle>
      <IconButton label={appCopy.canon.close} data-test-class="canon-aside-close" onClick={() => void select(null)}><X size="sm" /></IconButton>
    </Stack>
    <ErrorBoundary key={epicId} scope="canon-aside"><EpicInspector focusTitle projectId={projectId} epicId={epicId} /></ErrorBoundary>
  </Stack></Box>;
  return layout === "docked" ? <Card padding="none">{content}</Card> : content;
}
