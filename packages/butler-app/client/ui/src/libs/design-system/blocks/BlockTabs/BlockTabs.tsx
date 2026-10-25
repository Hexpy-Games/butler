import { useId, type ReactNode } from "react";
import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/Tabs";

export interface BlockTab {
  /** A few words; the tab's name. */
  label: string;
  /** The tab's content blocks. A tab never holds another BlockTabs or BlockColumns. */
  content: ReactNode;
}

export interface BlockTabsProps extends DsPrivateStyleProps {
  tabs: BlockTab[];
  /** Names the tab list when no visible title does. */
  ariaLabel?: string;
}

/** Content blocks split over line tabs; the first tab is open. */
export function BlockTabs({ tabs, ariaLabel, className }: BlockTabsProps) {
  const id = useId();
  return (
    <Tabs className={className} data-slot="block-tabs" defaultValue={`${id}-0`} gap="md">
      <TabsList aria-label={ariaLabel} variant="line">
        {tabs.map((tab, index) => <TabsTrigger key={index} value={`${id}-${index}`}>{tab.label}</TabsTrigger>)}
      </TabsList>
      {tabs.map((tab, index) => <TabsContent key={index} value={`${id}-${index}`}>{tab.content}</TabsContent>)}
    </Tabs>
  );
}
