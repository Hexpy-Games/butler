import { useEffect, useRef, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { LiveTabCard, Stack, type AsideLayout } from "@/butler-ds";
import { agentTabCardProps } from "../browser/agentTabCardProps.ts";
import type { BrowserTab } from "../browser/browserBridge.ts";
import { useDocumentVisible, useLiveFrames } from "../browser/useLiveFrames.ts";
import { SessionSection } from "./SessionSection.tsx";

/** Mounted by SessionSections only when browser tabs can be opened. */
export function BrowserSection({ layout, session, tabs }: { layout: AsideLayout; session: string; tabs: readonly BrowserTab[] }) {
  useAppLocale();
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
  const frames = useLiveFrames(tabs.map(tab => tab.id), 416, !documentVisible || !inView);
  return <SessionSection id="browser" layout={layout} title={appCopy.sessionInfo.browser} count={tabs.length}>
    <div ref={content}><Stack gap="sm">{tabs.map(tab => <LiveTabCard key={tab.id} variant="full"
      {...agentTabCardProps(session, tab, frames[tab.id])} closeLabel={appCopy.browser.closeTab} />)}</Stack></div>
  </SessionSection>;
}
