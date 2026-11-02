import type { HTMLAttributes } from "react";
import { Stack } from "../../components/Stack";
import type { DsBaseProps } from "../../lib/dsProps";
import { LiveTabCard, type LiveTabCardProps } from "../LiveTabCard";
import { LiveTabListToggle } from "./LiveTabListToggle";

export interface LiveTabListProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "children"> {
  tabs: readonly (LiveTabCardProps & { id: string })[];
  limit?: number;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  labels: { more: (count: number) => string; overflow: (count: number) => string; less: string };
  dataTestClass?: string;
}

/** Full previews followed by one stable, keyboard-operable overflow toggle. */
export function LiveTabList({ tabs, limit = 3, expanded, onExpandedChange, labels, dataTestClass, ...props }: LiveTabListProps) {
  const cap = Math.max(0, Math.floor(limit));
  const hidden = tabs.slice(cap);
  return <Stack gap="sm" data-test-class={dataTestClass} {...props}>
    {(expanded ? tabs : tabs.slice(0, cap)).map(tab => <LiveTabCard key={tab.id} {...tab} variant="full" />)}
    {hidden.length > 0 ? <LiveTabListToggle key="toggle" tabs={hidden} expanded={expanded} labels={labels}
      onToggle={() => onExpandedChange(!expanded)} /> : null}
  </Stack>;
}
