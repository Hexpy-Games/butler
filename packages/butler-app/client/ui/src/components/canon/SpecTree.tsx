import { useEffect, useRef, useState } from "react";
import { getCanonSpec, type CanonSpecDetail } from "@/app/canonApi.ts";
import type { SpecNode } from "@/app/canonApi.ts";
import { appCopy } from "@/app/copy.ts";
import type { ReactNode } from "react";
import { Box, DisclosureRow, Notice, Section, Skeleton, Stack, Typo } from "@/butler-ds";
import { EpicMarkdown } from "./EpicMarkdown.tsx";
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
  const hasChildren = typeof node.active_revision === "number" || node.children.length > 0 || node.criteria.length > 0;
  const parts = new Map<string, SpecNode["criteria"]>();
  for (const criterion of node.criteria) {
    const group = parts.get(criterion.part_id) ?? [];
    group.push(criterion); parts.set(criterion.part_id, group);
  }
  return <DisclosureRow title={node.concern_id} surface="plain" open={open} onToggle={() => setOpen(!open)}>
    {hasChildren ? <TreeChildren>
      {typeof node.active_revision === "number" ? <SpecBody nodeId={node.node_id} revision={node.active_revision} /> : null}
      {[...parts].map(([part, criteria]) => <SpecPart key={part} part={part} criteria={criteria} node={node} onRefresh={onRefresh} />)}
      {node.children.map(child => <SpecNodeRow key={child.node_id} node={child} onRefresh={onRefresh} />)}
    </TreeChildren> : undefined}
  </DisclosureRow>;
}
function SpecPart({ part, criteria, node, onRefresh }: { part: string; criteria: SpecNode["criteria"]; node: SpecNode; onRefresh: () => Promise<void> }) {
  const [open, setOpen] = useState(true);
  return <DisclosureRow title={part} surface="plain" open={open} onToggle={() => setOpen(!open)}>
    <TreeChildren>{criteria.map(criterion => <CriterionRow key={criterion.criterion_id} node={node} criterion={criterion} onRefresh={onRefresh} />)}</TreeChildren>
  </DisclosureRow>;
}
type SpecBodyState = { key: string; detail?: CanonSpecDetail; failed?: boolean };
/** The published body, collapsed by default: fetched on first open and again only for a new publication. */
function SpecBody({ nodeId, revision }: { nodeId: string; revision: number }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState<SpecBodyState | null>(null);
  const loaded = useRef("");
  const key = `${nodeId}:${revision}`;
  useEffect(() => {
    if (!open || loaded.current === key) return;
    loaded.current = key;
    setBody({ key });
    getCanonSpec(nodeId).then(
      detail => setBody(current => current?.key === key ? { key, detail } : current),
      () => { loaded.current = ""; setBody(current => current?.key === key ? { key, failed: true } : current); });
  }, [open, key, nodeId]);
  const current = body?.key === key ? body : null;
  return <DisclosureRow data-test-class="canon-spec-body" title={appCopy.canon.specBody} meta={appCopy.canon.specRevision(revision)}
    surface="plain" open={open} onToggle={() => setOpen(!open)}>
    {current?.detail ? <EpicMarkdown epicId="" description={current.detail.body ?? ""} density="compact" />
      : current?.failed ? <Notice tone="error" message={appCopy.interfaceFeedback.requestFailed} />
      : <Skeleton lines={3} />}
  </DisclosureRow>;
}
/** One tree level: children start one --space-md step right of their parent's title, the same step as 진행 순서 follow steps. */
function TreeChildren({ children }: { children: ReactNode }) {
  return <Box paddingStart="md"><Stack gap="sm">{children}</Stack></Box>;
}
