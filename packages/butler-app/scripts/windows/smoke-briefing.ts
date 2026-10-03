import { strict as assert } from "node:assert";

// Pin the fresh English profile's complete general-briefing contract.
const instructions = [
  "You generate Butler's New Chat Briefing artifact.", "Write visible copy in English.",
  "Return JSON only. Do not wrap it in Markdown.",
  "The title is the page headline: a short greeting or question, not a status label.",
  "For general briefings, include title_variants with morning, afternoon, evening, and night; these are also page headlines.",
  "For project briefings, do not include time-of-day title variants.",
  "Each card title names a topic. Each card description says why opening it may be useful.",
  "For project cards, turn historical topics into genuinely new directions; do not ask to repeat prior work or summarize what was already done.",
  "Do not pressure the user, create urgency, shame unfinished work, or tell the user what they must do.",
  "Do not describe the interface, the memory system, the prompt, the persona, or why you generated the artifact.",
  "Do not include raw transcript text, filesystem paths, private reasoning, or provider payloads.",
  "Create 4 to 6 suggestions.",
  "Apply the active persona subtly in phrasing, without turning the page into a performance.",
].join("\n");
const shape = {
  moment: "short time label", title: "one short fallback greeting or question for the surface",
  description: "one short sentence about why these cards are here",
  suggestions: [{ id: "stable-kebab-id", title: "topic name", description: "why this is useful to open",
    text: "message to send if selected", source_kind: "one allowed source kind" }],
  title_variants: { morning: "surface headline for local morning", afternoon: "surface headline for local afternoon",
    evening: "surface headline for local evening", night: "surface headline for local night" },
};

export interface SmokeBriefing {
  runId: string;
  generatedAt: string;
  reply: {
    moment: string; title: string; description: string;
    suggestions: Array<{ id: string; title: string; description: string; text: string; source_kind: string }>;
    title_variants: { morning: string; afternoon: string; evening: string; night: string };
  };
}

export function smokeBriefing(body: any): SmokeBriefing | null {
  if (typeof body.input !== "string" || !body.input.trimStart().startsWith("{")) return null;
  const input = JSON.parse(body.input);
  if (input.task !== "general_new_chat_briefing") return null;
  assert.equal(body.instructions, instructions);
  assert.ok(!body.text?.format?.name, "Unexpected structured briefing format");
  assert.deepEqual(Object.keys(input).sort(), ["task", "locale", "now", "time_of_day", "consolidation_run_id",
    "persona", "runtime_projection", "profile_summaries", "project", "scope_rules", "output_shape"].sort());
  assert.equal(input.locale, "en");
  assert.ok(Number.isFinite(Date.parse(input.now)));
  assert.match(input.consolidation_run_id, /^cr_scheduled_\d{14}$/u);
  assert.ok(["morning", "afternoon", "evening", "night"].includes(input.time_of_day));
  assert.equal(input.persona.id, "active");
  assert.ok(input.persona.excerpt.startsWith("---\nname: active\nbase: butler\nbase_locale: en\n---\n"));
  assert.equal(input.runtime_projection, null);
  assert.deepEqual(input.profile_summaries, []);
  assert.equal(input.project, null);
  assert.deepEqual(input.scope_rules, [
    "Use general user-level signals, unfinished topics, repeated questions, current interests, adjacent directions, and timely context.",
    "Do not turn unfinished work into pressure or obligation.",
  ]);
  assert.deepEqual(input.output_shape, shape);
  return { runId: input.consolidation_run_id, generatedAt: input.now, reply: {
    moment: "Today", title: "What would you like to explore?", description: "A few optional starting points.",
    suggestions: ["reading", "walking", "cooking", "learning"].map(id => ({
      id, title: id, description: `Explore ${id} at your own pace.`, text: `Let's discuss ${id}.`, source_kind: "current_interest",
    })),
    title_variants: { morning: "Good morning", afternoon: "Good afternoon", evening: "Good evening", night: "Good night" },
  } };
}
