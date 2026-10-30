import { useRef, useState } from "react";
import { checkCanonCriterion, type SpecCriterion, type SpecNode } from "@/app/canonApi.ts";
import { appCopy } from "@/app/copy.ts";
import { Box, Circle, IconButton, RollingSwap, Stack, SuccessCheck, Typo } from "@/butler-ds";
import { canonWriteFailure } from "./canonFeedback.ts";

export function CriterionRow({ node, criterion, onRefresh }: {
  node: SpecNode; criterion: SpecCriterion; onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const toggle = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try {
      await checkCanonCriterion(node.node_id, criterion.criterion_id, { confirmed: !criterion.confirmed, expected_revision: node.revision });
      await onRefresh();
    } catch (error) { await canonWriteFailure(error, onRefresh); }
    finally { pending.current = false; setBusy(false); }
  };
  return <Box paddingY="xs" data-test-class="canon-criterion" data-criterion-id={criterion.criterion_id}>
    <Stack gap="xs">
      <Stack align="row" cross="center" justify="between">
        <Typo.Code>{criterion.criterion_id}</Typo.Code>
        <IconButton label={appCopy.canon.criterionState(criterion.criterion_id, criterion.confirmed)}
          pressed={criterion.confirmed} tone={criterion.confirmed ? "butler" : "default"} aria-disabled={busy} onClick={() => void toggle()}>
          <RollingSwap itemKey={String(criterion.confirmed)}>{criterion.confirmed ? <SuccessCheck ring animate={false} /> : <Circle size="sm" />}</RollingSwap>
        </IconButton>
      </Stack>
      <Typo.Body wrap="anywhere">{criterion.text}</Typo.Body>
    </Stack>
  </Box>;
}
