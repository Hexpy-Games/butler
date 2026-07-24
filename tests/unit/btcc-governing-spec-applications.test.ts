import { expect, test } from "bun:test";
import {
  governingSpecLogicalIds,
  requireGoverningSpecApplications,
} from "../../packages/butler-agent/src/agent/btcc/conception/governing-spec-applications.ts";
import { goalCandidateSubmissionSchema } from
  "../../packages/butler-agent/src/agent/btcc/conception/submission-schemas.ts";

test("keeps request change obligations separate from preservation constraints", () => {
  const governingSpecApplications = requireGoverningSpecApplications([
    {
      logicalId: "SPEC-PROFILE",
      changeObligations: ["Reduce trust after repeated hostile behavior"],
      preservationConstraints: ["Keep the accepted profile cycle unchanged"],
    },
    {
      logicalId: "SPEC-FEEDBACK",
      changeObligations: [],
      preservationConstraints: ["Do not promote unreviewed feedback"],
    },
  ]);

  expect(governingSpecLogicalIds({ governingSpecApplications })).toEqual([
    "SPEC-PROFILE",
    "SPEC-FEEDBACK",
  ]);
  expect(governingSpecApplications[1]?.changeObligations).toEqual([]);
});

test("rejects a selected Spec with no request-specific application", () => {
  expect(() =>
    requireGoverningSpecApplications([{
      logicalId: "SPEC-UNRELATED",
      changeObligations: [],
      preservationConstraints: [],
    }]),
  ).toThrow("has no applicable obligation");
});

test("rejects duplicate governing Spec logical identities", () => {
  expect(() =>
    requireGoverningSpecApplications([
      {
        logicalId: "SPEC-PROFILE",
        changeObligations: ["Change one behavior"],
        preservationConstraints: [],
      },
      {
        logicalId: "SPEC-PROFILE",
        changeObligations: [],
        preservationConstraints: ["Preserve another behavior"],
      },
    ]),
  ).toThrow("duplicate logicalIds");
});

test("rejects a governing Spec identity outside the admitted catalog", () => {
  expect(() =>
    requireGoverningSpecApplications([{
      logicalId: "project-root-id",
      changeObligations: ["Treat the project root as a Spec"],
      preservationConstraints: [],
    }], ["SPEC-PROFILE"]),
  ).toThrow("outside the admitted catalog");
});

test("closes the provider schema over the admitted governing Spec catalog", () => {
  const empty = goalCandidateSubmissionSchema([]);
  const emptyProperties = empty.properties as Record<string, Record<string, unknown>>;
  expect(emptyProperties.governingSpecApplications?.maxItems).toBe(0);

  const admitted = goalCandidateSubmissionSchema(["SPEC-PROFILE", "SPEC-FEEDBACK"]);
  const properties = admitted.properties as Record<string, Record<string, unknown>>;
  const items = properties.governingSpecApplications?.items as {
    properties: Record<string, Record<string, unknown>>;
  };
  expect(items.properties.logicalId?.enum).toEqual([
    "SPEC-PROFILE",
    "SPEC-FEEDBACK",
  ]);
});
