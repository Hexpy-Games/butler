import { useState } from "react";
import type { SpecNode } from "@/app/canonApi.ts";
import { appCopy } from "@/app/copy.ts";
import { DisclosureRow, Section, Stack, Typo } from "@/butler-ds";
/** The current wire has criteria text, but no confirmation/coverage projection. */
export function SpecTree({ nodes, compact = false }: { nodes: SpecNode[]; compact?: boolean }) {
  return <Section title={compact ? <Typo.Caption tone="secondary" weight="medium">{appCopy.canon.specs}</Typo.Caption> : appCopy.canon.specs} gap="sm">
    {nodes.length ? nodes.map(node => <SpecNodeRow key={node.node_id} node={node} />) : <Typo.Caption tone="secondary">{appCopy.canon.noSpecs}</Typo.Caption>}
  </Section>;
}
function SpecNodeRow({ node }: { node: SpecNode }) {
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
      {[...parts].map(([part, criteria]) => <SpecPart key={part} part={part} criteria={criteria} />)}
      {node.children.map(child => <SpecNodeRow key={child.node_id} node={child} />)}
    </Stack> : undefined}
  </DisclosureRow>;
}
function SpecPart({ part, criteria }: { part: string; criteria: SpecNode["criteria"] }) {
  const [open, setOpen] = useState(true);
  return <DisclosureRow title={part} surface="plain" open={open} onToggle={() => setOpen(!open)}>
    <Stack gap="sm">{criteria.map(criterion => <Stack key={criterion.criterion_id} align="row" cross="start" gap="sm">
      <Typo.Code>{criterion.criterion_id}</Typo.Code><Typo.Body>{criterion.text}</Typo.Body>
    </Stack>)}</Stack>
  </DisclosureRow>;
}
