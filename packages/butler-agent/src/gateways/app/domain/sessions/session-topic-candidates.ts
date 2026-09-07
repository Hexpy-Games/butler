export interface TopicCandidate {
  key: string; kind: "session" | "group"; title: string; topic: string | null; updatedAt: string; revision: number;
}
export const normalizeTopic = (value: string) => value.normalize("NFKC").toLocaleLowerCase();

function grams(value: string): Set<string> {
  const chars = Array.from(normalizeTopic(value));
  return new Set(chars.length < 2 ? chars : chars.slice(1).map((char, i) => chars[i]! + char));
}

/** Titles/topics only. Unchanged entries keep their postings between classifications. */
export class SessionTopicCandidates {
  private entries = new Map<string, { value: TopicCandidate; grams: Set<string> }>();
  private postings = new Map<string, Set<string>>();

  sync(values: TopicCandidate[]): void {
    const incoming = new Set(values.map(value => value.key));
    for (const key of this.entries.keys()) if (!incoming.has(key)) this.remove(key);
    for (const value of values) {
      const old = this.entries.get(value.key);
      if (old?.value.title === value.title && old.value.topic === value.topic) { old.value = value; continue; }
      this.remove(value.key);
      const tokens = grams(`${value.title} ${value.topic ?? ""}`);
      this.entries.set(value.key, { value, grams: tokens });
      for (const token of tokens) {
        const posting = this.postings.get(token) ?? new Set<string>();
        posting.add(value.key); this.postings.set(token, posting);
      }
    }
  }

  choose(text: string, exclude: string): TopicCandidate[] {
    const query = grams(text);
    const overlap = new Map<string, number>();
    for (const token of query) for (const key of this.postings.get(token) ?? []) {
      if (key !== exclude) overlap.set(key, (overlap.get(key) ?? 0) + 1);
    }
    const compare = (a: string, b: string) => this.entries.get(b)!.value.updatedAt.localeCompare(this.entries.get(a)!.value.updatedAt) || a.localeCompare(b);
    const score = (key: string) => overlap.get(key)! / (query.size + this.entries.get(key)!.grams.size - overlap.get(key)!);
    const lexical = [...overlap.keys()].sort((a, b) => score(b) - score(a) || compare(a, b)).slice(0, 16);
    const recent = [...this.entries.keys()].filter(key => key !== exclude).sort(compare).slice(0, 8);
    return [...new Set([...lexical, ...recent])].map(key => this.entries.get(key)!.value);
  }

  private remove(key: string): void {
    for (const token of this.entries.get(key)?.grams ?? []) {
      const posting = this.postings.get(token)!;
      posting.delete(key);
      if (!posting.size) this.postings.delete(token);
    }
    this.entries.delete(key);
  }
}
