import { expect, test } from "bun:test";
import { mergeSettings } from "./merge";
import { draftFromPersonalization, personalizationUpdatePayload, resolvePersonaPreset, selectPersonaPreset } from "./personalization";
import { moveBackupModel, selectableBackupModels } from "./backupModelsUtils";
import { groupGrants, type GrantRecord } from "./grantRows";
import type { AppModelSummary, PersonalizationView } from "./types";

// test-category: pure-logic
test("mergeSettings preserves nested web_search fields", () => {
  const current: { show_thinking: boolean; web_search: { provider: string; planning_enabled?: boolean } } = {
    show_thinking: true, web_search: { provider: "auto", planning_enabled: true },
  };
  const merged = mergeSettings(current, { web_search: { provider: "brave" } });
  expect(merged).toEqual({ show_thinking: true, web_search: { provider: "brave", planning_enabled: true } });
  expect(current.web_search.provider).toBe("auto");
});

// test-category: pure-logic
test("personalization payload preserves preset frontmatter and sends custom edits", () => {
  const content = "---\nname: concise\n---\n\nBe concise.";
  const personalization = { persona: "A custom style.", eol: "", response_language: "en",
    persona_presets: [{ name: "concise", content }] } as PersonalizationView;
  const draft = selectPersonaPreset(draftFromPersonalization(personalization), personalization, "concise");
  expect(resolvePersonaPreset(content, personalization)).toBe("concise");
  expect(personalizationUpdatePayload(personalization, draft)).toEqual({ persona: content });
  const custom = { ...draft, personaPreset: "custom", persona: "Explain each step." };
  expect(resolvePersonaPreset(custom.persona, personalization)).toBe("custom");
  expect(personalizationUpdatePayload(personalization, custom)).toEqual({ persona: custom.persona });
});

// test-category: pure-logic
test("selectableBackupModels excludes primary and selected identities and supports moving both ways", () => {
  const models = [
    { model_ref: "primary", model_id: "a" }, { model_ref: "alias", model_id: "a" },
    { model_ref: "selected", model_id: "b" }, { model_ref: "candidate", model_id: "c" },
  ].map(m => ({ ...m, provider_id: "provider", registered: true, runtime_supported: true } as AppModelSummary));
  expect(selectableBackupModels(models, "primary", ["selected"]).map(m => m.model_ref)).toEqual(["candidate"]);
  const order = ["selected", "candidate"];
  expect(moveBackupModel(order, 1, -1)).toEqual(["candidate", "selected"]);
  expect(moveBackupModel(order, 0, 1)).toEqual(["candidate", "selected"]);
  expect(order).toEqual(["selected", "candidate"]);
});

// test-category: pure-logic
test("groupGrants retains references and conversations for a shared approval", () => {
  const records: GrantRecord[] = ["first", "second"].map((session_id, index) => ({
    grant_ref: `grant-${session_id}`, session_id, capability: "write_file", target: "/workspace/report.txt",
    cwd: null, scope: "always", session_title: session_id, project_id: null, project_name: null,
    workspace_path: "/workspace", created_at: `2026-01-0${index + 1}T00:00:00Z`,
  }));
  const rows = groupGrants(records);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.kind).toBe("fileWrite");
  expect(rows[0]!.refs).toEqual(records.map(({ grant_ref, session_id }) => ({ grant_ref, session_id })));
  expect([...rows[0]!.places.keys()]).toEqual(["first", "second"]);
  expect(rows[0]!.createdAt).toBe(records[1]!.created_at);
});
