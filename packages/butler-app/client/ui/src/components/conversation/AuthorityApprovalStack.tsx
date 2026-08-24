import { useRef, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import {
  selectActiveAuthorityApprovals,
  useButlerStore,
} from "@/app/store.ts";
import type { AuthorityApprovalCard } from "@/app/types.ts";
import { Stack } from "@/butler-ds";
import styles from "./AuthorityApprovalStack.module.css";
import { AuthorityApprovalNoticePresenter } from "./AuthorityApprovalNoticePresenter";

/**
 * Container for the durable authority approval stack. Backend projection
 * remains authoritative; local state only fences a clicked button and shows
 * a fixed failure message while the Composer and sibling cards stay usable.
 */
export function AuthorityApprovalStack() {
  const approvals = useButlerStore(selectActiveAuthorityApprovals);
  const sessionId = useButlerStore((state) => state.activeChatId);
  if (approvals.length === 0) return null;

  return (
    <Stack align="column" className={styles.stack} gap="xs">
      {approvals.map((approval) => (
        <AuthorityApprovalCardActions
          approval={approval}
          key={`${sessionId}:${approval.requestRef}`}
          sessionId={sessionId}
        />
      ))}
    </Stack>
  );
}

const MAX_ALTERNATIVE_BYTES = 16 * 1024;

function validAlternative(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) return null;
  return new TextEncoder().encode(normalized).byteLength <= MAX_ALTERNATIVE_BYTES
    ? normalized
    : null;
}

function AuthorityApprovalCardActions({
  approval,
  sessionId,
}: {
  approval: AuthorityApprovalCard;
  sessionId: string;
}) {
  const allow = useButlerStore((state) => state.allowAuthorityRequest);
  const deny = useButlerStore((state) => state.denyAuthorityRequest);
  const modify = useButlerStore((state) => state.modifyAuthorityRequest);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [modifyOpen, setModifyOpen] = useState(false);
  const [modifyValue, setModifyValue] = useState("");
  const normalizedAlternative = validAlternative(modifyValue);
  const copy = appCopy.composer.approval;

  const submit = async (
    decision: () => Promise<boolean>,
    clearsAlternative = false,
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setFailed(false);
    if (clearsAlternative) {
      setModifyValue("");
      setModifyOpen(false);
    }
    const accepted = await decision();
    inFlight.current = false;
    setPending(false);
    if (!accepted) setFailed(true);
  };

  return (
    <AuthorityApprovalNoticePresenter
      allowLabel={copy.allowOnce}
      denyLabel={copy.deny}
      error={failed ? copy.decisionFailed : undefined}
      meta={`${copy.categoryCommand} · ${copy.commandSummary(
        approval.executable,
        approval.commandCount,
      )}`}
      modifyInvalid={
        modifyOpen && modifyValue.length > 0 && !normalizedAlternative
          ? copy.modifyInvalid
          : undefined
      }
      modifyLabel={copy.modify}
      modifyOpen={modifyOpen}
      modifyPlaceholder={copy.modifyPlaceholder}
      modifySubmitDisabled={!normalizedAlternative}
      modifySubmitLabel={copy.submitModify}
      modifyValue={modifyValue}
      onAllow={() => void submit(
        () => allow(approval.requestRef, sessionId),
      )}
      onDeny={() => void submit(
        () => deny(approval.requestRef, sessionId),
      )}
      onModify={() => {
        setFailed(false);
        setModifyOpen(true);
      }}
      onModifyChange={setModifyValue}
      onModifySubmit={() => {
        if (!normalizedAlternative) return;
        const alternative = normalizedAlternative;
        void submit(
          () => modify(approval.requestRef, alternative, sessionId),
          true,
        );
      }}
      pending={pending}
      reason={approval.reason}
      title={copy.title}
    />
  );
}
