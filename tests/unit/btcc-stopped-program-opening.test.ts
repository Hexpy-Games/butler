import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { discoverContinuationCandidates } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/continuation-candidate-discovery.ts";
import { decideContinuation } from
  "../../packages/butler-agent/src/agent/btcc/conception/continuation/index.ts";
import { openingAnswerCodec } from
  "../../packages/butler-agent/src/agent/btcc/conception/opening/opening-answer-codec.ts";
import { decideTransition } from
  "../../packages/butler-agent/src/agent/btcc/turn/state-machine/decide-transition.ts";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/contracts.ts";
import {
  freshContinuationCommand,
  seedStoppedProgram,
} from "./support/btcc-stopped-work-fixture.ts";

test("Opening proposes an exact stopped Program only through the Managed route", async () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  await seedStoppedProgram(db);
  const candidates = await discoverContinuationCandidates(db, freshContinuationCommand());
  const candidate = candidates[0]!;
  const codec = openingAnswerCodec(candidates.map(({ candidateId }) => candidateId));
  const envelope = {
    binding: { turnId: "turn-resume-opening" },
    context: { continuationCandidates: candidates },
  } as never;

  expect(() => codec.decode(programContinuation("unavailable-candidate"), envelope))
    .toThrow("unavailable continuation candidate");
  const product = codec.decode(programContinuation(candidate.candidateId), envelope);
  expect(product).toMatchObject({
    kind: "opening_continuation",
    continuationMode: "managed_program",
    route: "managed",
    continuationProposal: {
      candidateId: candidate.candidateId,
      sourceTurnId: candidate.sourceTurnId,
      programId: candidate.programId,
    },
  });
  expect(decideTransition({
    turnId: "turn-resume-opening",
    revision: 1,
    semanticState: "conception_opening",
  } as TurnRecord, { kind: "OpeningContinuationAccepted", product: product as never }))
    .toMatchObject({
      kind: "accepted",
      transition: {
        kind: "accept_opening_continuation",
        successor: "conception_deliberation",
      },
    });

  expect(decideContinuation({
    kind: "bind",
    continuationCandidateId: candidate.candidateId,
  }, { continuationCandidates: candidates }, "inbox-resume", candidate.candidateId))
    .toMatchObject({
      binding: { kind: "stopped_program", programId: candidate.programId },
      reviewDecision: { kind: "bind", continuationCandidateId: candidate.candidateId },
    });
  expect(decideContinuation({
    kind: "reject",
    continuationCandidateId: candidate.candidateId,
    rationale: "The new request is materially different",
  }, { continuationCandidates: candidates }, "inbox-new", candidate.candidateId))
    .toMatchObject({
      binding: { kind: "new_request" },
      reviewDecision: { kind: "reject", continuationCandidateId: candidate.candidateId },
    });
  expect(() => decideContinuation(undefined, {
    continuationCandidates: candidates,
  }, "inbox-invalid", candidate.candidateId)).toThrow("Continuation review decision");

  const unrelatedAssisted = codec.decode({
    kind: "assisted_continuation",
    requiredResultKind: "current_observation",
    requestObligation: "Check the current weather",
    summary: "Check a bounded current fact",
    rationale: "This new request is unrelated to the stopped Program",
    nextStep: "Observe the current weather and answer",
  }, envelope);
  expect(unrelatedAssisted).toMatchObject({
    continuationMode: "assisted_request",
    route: "assisted",
  });
  expect(unrelatedAssisted).not.toHaveProperty("continuationProposal");
  db.close();
});

function programContinuation(continuationCandidateId: string) {
  return {
    kind: "managed_program_continuation",
    requiredResultKind: "durable_work",
    continuationCandidateId,
    requestObligation: "Continue the stopped work",
    summary: "Resume the preserved Program",
    rationale: "The user selected its unfinished frontier",
    nextStep: "Review the accepted Goal and remaining Plan",
  };
}
