import { expect, test } from "bun:test";
import {
  governingSpecLogicalIds,
  requireGoverningSpecApplications,
} from "../../packages/butler-agent/src/agent/btcc/conception/governing-spec-applications.ts";

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
