import type { StubModelRequest } from "../../tests/support/native-app-server.ts";
import type { Demo } from "./demo.ts";

type PatternEvent = { id: string; text: string; at_local: string };
type MemoryTask = { task?: string; events?: PatternEvent[]; patterns?: { id: string; title: string }[] };

function decodeTask(text: string): MemoryTask | null {
  try {
    const value = JSON.parse(text) as MemoryTask | null;
    return typeof value?.task === "string" ? value : null;
  } catch { return null; }
}

function patternUpdates(task: MemoryTask, words: Demo) {
  const prompts = [[words.A[1], words.B[1]], [words.C[1]]] as const;
  const hourLabel = (hour: number) => `${String(hour % 24).padStart(2, "0")}:00`;
  return {
    updates: words.patterns.flatMap(([title, intent], index) => {
      const expected: readonly string[] = prompts[index];
      const events = (task.events ?? []).filter(event => expected.includes(event.text.trim()));
      if (!expected.every(text => events.some(event => event.text.trim() === text))) return [];
      const dates = events.map(event => /\b(mon|tue|wed|thu|fri|sat|sun) (\d{2}):\d{2}$/iu.exec(event.at_local));
      if (dates.some(date => !date)) return [];
      const days = [...new Set(dates.map(date => date![1].toLowerCase()))];
      const hours = dates.map(date => Number(date![2]));
      const window = { days, start: hourLabel(Math.min(...hours)), end: hourLabel(Math.max(...hours) + 1) };
      return [{ pattern_id: task.patterns?.find(pattern => pattern.title === title)?.id ?? null,
        title, intent, window, evidence_ids: events.map(event => event.id) }];
    }),
  };
}

export function memoryReply(request: StubModelRequest, words: Demo, counts: Record<string, number>) {
  const user = request.messages.findLast(message => (message as { role?: string }).role === "user") as
    { content?: string | { text?: string }[] } | undefined;
  const content = user?.content;
  const text = typeof content === "string" ? content : content?.map(part => part.text ?? "").join("\n") ?? "";
  const ref = /^Import ref: (third_party_profile_import:[^\r\n]+)$/mu.exec(text)?.[1];
  if (ref) {
    counts.profile_import = (counts.profile_import ?? 0) + 1;
    return JSON.stringify({ candidates: [{
      category: "communication", summary: words.profileSummary, source_type: "explicit",
      confidence: "high", evidence_refs: [ref], butler_should: [words.profileSummary],
    }] });
  }
  const payload = decodeTask(text);
  if (!payload?.task) return undefined;
  switch (payload.task) {
    case "pattern_extraction":
      counts.pattern_extraction = (counts.pattern_extraction ?? 0) + 1;
      return JSON.stringify(patternUpdates(payload, words));
    case "pattern_proposal":
    case "extract_profile_candidates":
      counts[payload.task] = (counts[payload.task] ?? 0) + 1;
      return JSON.stringify({ candidates: [] });
    default:
      counts.other_memory_tasks = (counts.other_memory_tasks ?? 0) + 1;
      return JSON.stringify({ candidates: [] });
  }
}
