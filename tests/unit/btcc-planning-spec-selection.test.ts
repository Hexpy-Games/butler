import { describe, expect, test } from "bun:test";
import { selectableGoverningSpecIds } from
  "../../packages/butler-agent/src/agent/btcc/planning/decode-available-specs.ts";
import { planCandidateSubmissionSchema } from
  "../../packages/butler-agent/src/agent/btcc/planning/submission-schemas.ts";

const ref = (id: string) => ({ id, sha256: `${id}-sha` });
const availableSpec = (logicalId: string, revisionRef: ReturnType<typeof ref>) => ({
  logicalId,
  parentId: "project-1",
  concernId: logicalId,
  title: `${logicalId} contract`,
  status: "specified",
  revisionRef,
});

describe("BTCC Planning governing Spec selection", () => {
  test("exposes only GoalContract-admitted revisions as selectable authority", () => {
    const admitted = ref("spec-admitted-revision");
    const observedOnly = ref("spec-observed-only-revision");
    const available = [
      availableSpec("SPEC-ADMITTED", admitted),
      availableSpec("SPEC-OBSERVED-ONLY", observedOnly),
    ];

    expect(selectableGoverningSpecIds(available, [admitted]))
      .toEqual(["SPEC-ADMITTED"]);
    expect(selectableGoverningSpecIds(available, [])).toEqual([]);

    const admittedSchema = JSON.stringify(planCandidateSubmissionSchema(
      selectableGoverningSpecIds(available, [admitted]),
    ));
    expect(admittedSchema).toContain('"enum":["SPEC-ADMITTED"]');
    expect(admittedSchema).not.toContain("SPEC-OBSERVED-ONLY");

    const authorOnlySchema = JSON.stringify(planCandidateSubmissionSchema(
      selectableGoverningSpecIds(available, []),
    ));
    expect(authorOnlySchema).not.toContain("governingSpecSelections");
    expect(authorOnlySchema).toContain("specifications");
  });
});
