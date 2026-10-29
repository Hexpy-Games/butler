import { useState } from "react";
import type { SpecNode } from "@/app/canonApi.ts";
import { appCopy } from "@/app/copy.ts";
import { DisclosureRow, Section, Stack, Typo } from "@/butler-ds";
import { CriteriaProgress } from "./CriteriaProgress.tsx";
import { CriterionRow } from "./CriterionRow.tsx";
import type { CriteriaCount } from "@/app/canonApi.ts";
export function SpecTree({ nodes, criteria, onRefresh, compact = false }: { nodes: SpecNode[]; criteria?: CriteriaCount | null; onRefresh: () => Promise<void>; compact?: boolean }) {
  return <Section data-test-class="canon-spec-tree" title={criteria ? undefined : compact ? <Typo.Caption tone="secondary" weight="medium">{appCopy.canon.specs}</Typo.Caption> : appCopy.canon.specs} gap="sm">
    <CriteriaProgress criteria={criteria} label={appCopy.canon.specs} />
    {nodes.length ? nodes.map(node => <SpecNodeRow key={node.node_id} node={node} onRefresh={onRefresh} />) : <Typo.Caption tone="secondary">{appCopy.canon.noSpecs}</Typo.Caption>}
  </Section>;
}
function SpecNodeRow({ node, onRefresh }: { node: SpecNode; onRefresh: () => Promise<void> }) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0 || node.criteria.length > 0;
  const parts = new Map<string, SpecNode["criteria"]>();
  for (const criterion of node.criteria) {
    const group = parts.get(criterion.part_id) ?? [];
    group.push(criterion); parts.set(criterion.part_id, group);
  }
  return <DisclosureRow title={node.concern_id} surface="plain" open={open} onToggle={() => setOpen(!open)}
    affordance={hasChildren ? "leading" : "none"}>
    {hasChildren ? <Stack gap="sm">
      {[...parts].map(([part, criteria]) => <SpecPart key={part} part={part} criteria={criteria} node={node} onRefresh={onRefresh} />)}
      {node.children.map(child => <SpecNodeRow key={child.node_id} node={child} onRefresh={onRefresh} />)}
    </Stack> : undefined}
  </DisclosureRow>;
}
function SpecPart({ part, criteria, node, onRefresh }: { part: string; criteria: SpecNode["criteria"]; node: SpecNode; onRefresh: () => Promise<void> }) {
  const [open, setOpen] = useState(true);
  return <DisclosureRow title={part} surface="plain" open={open} onToggle={() => setOpen(!open)}>
    <Stack gap="sm">{criteria.map(criterion => <CriterionRow key={criterion.criterion_id} node={node} criterion={criterion} onRefresh={onRefresh} />)}</Stack>
  </DisclosureRow>;
}
