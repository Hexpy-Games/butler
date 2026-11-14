import { useEffect, useRef, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { DocumentTile, Globe2, LiveTabList, Stack, type AsideLayout } from "@/butler-ds";
import { useButlerStore } from "@/app/store.ts";
import type { SessionArtifactSummary } from "@/app/types.ts";
import { agentTabCardProps } from "../browser/agentTabCardProps.ts";
import type { BrowserTab } from "../browser/browserBridge.ts";
import { useDocumentVisible, useLiveFrames } from "../browser/useLiveFrames.ts";
import { SessionSection } from "./SessionSection.tsx";

/** Full previews before the overflow row; only these subscribe to live frames. */
const SHOWN_TABS = 3;

/** Mounted by SessionSections only when browser tabs can be opened. */
export function BrowserSection({ layout, session, tabs }: { layout: AsideLayout; session: string; tabs: readonly BrowserTab[] }) {
  useAppLocale();
  const [expanded, setExpanded] = useState(false);
  const documentVisible = useDocumentVisible();
  const content = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const element = content.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting));
    observer.observe(element);
    return () => observer.disconnect();
  }, [layout]);
  const frames = useLiveFrames((expanded ? tabs : tabs.slice(0, SHOWN_TABS)).map(tab => tab.id), 416, !documentVisible || !inView);
  return <SessionSection id="browser" layout={layout} title={appCopy.sessionInfo.browser} count={tabs.length}>
    <div ref={content}><LiveTabList limit={SHOWN_TABS} expanded={expanded} onExpandedChange={setExpanded}
      labels={{ more: appCopy.sessionInfo.browserMore, less: appCopy.sessionInfo.browserLess,
        overflow: count => appCopy.browser.moreTabs.replace("{count}", String(count)) }}
      tabs={tabs.map(tab => ({ ...agentTabCardProps(session, tab, frames[tab.id]), closeLabel: appCopy.browser.closeTab }))} /></div>
  </SessionSection>;
}

/** Mounted instead of BrowserSection where no native browser exists; a tile opens the preview in the file viewer. */
export function PreviewSection({ layout, previews }: { layout: AsideLayout; previews: readonly SessionArtifactSummary[] }) {
  useAppLocale();
  const openArtifact = useButlerStore(state => state.openArtifact);
  return <SessionSection id="browser" layout={layout} title={appCopy.sessionInfo.browser} count={previews.length}>
    <Stack gap="xs">
      {previews.map(preview => <DocumentTile key={preview.id} ariaLabel={`${appCopy.artifacts.open}: ${preview.title}`}
        clickTarget="tile" icon={<Globe2 size="md" />} title={preview.title} onOpen={() => openArtifact(preview)} />)}
    </Stack>
  </SessionSection>;
}
