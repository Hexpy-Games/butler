import type { Database } from "bun:sqlite";
import type { RecallMemoryInput, RecallMemoryResult } from "./contracts.ts";
import { readClaim } from "../projection/claim-store.ts";
import { rawMemorySourceId } from "./source-ref.ts";

type Interpretation = NonNullable<RecallMemoryResult["results"][number]["interpretations"]>[number];
/** Attach interpretations only to evidence actually delivered by the public recall path. */
export function resultInterpretations(db: Database, input: RecallMemoryInput, evidence: RecallMemoryResult["results"][number]["evidence"]): Interpretation[] {
  const refs = new Map(evidence.map((item) => [rawMemorySourceId(item.source_ref), item.source_ref]));
  if (!refs.size) return [];
  const nodes = db.query<{ node_id: string }, any>(`SELECT DISTINCT c.node_id FROM memory_claims c
    JOIN memory_evidence e ON e.node_id=c.node_id WHERE e.source_id IN (${[...refs].map(() => "?").join(",")}) ORDER BY c.node_id LIMIT 8`).all(...refs.keys());
  return nodes.flatMap(({ node_id }) => {
    const claim = readClaim(db, node_id)!;
    const dependencies = db.query<{ source_id: string }, [string]>("SELECT source_id FROM memory_evidence WHERE node_id=?").all(node_id);
    const sources = dependencies.flatMap((row) => refs.has(row.source_id) ? [refs.get(row.source_id)!] : []);
    if (sources.length !== dependencies.length) return [];
    let status: Interpretation["status"] = (claim.valid_from && Date.parse(claim.valid_from) > Date.parse(input.asOf)) ||
      (claim.valid_to && Date.parse(claim.valid_to) <= Date.parse(input.asOf)) ? "historical" : "recorded";
    const changes = db.query<{ rel_type: string }, any>(`SELECT DISTINCT e.rel_type FROM edges e
      JOIN edge_evidence ee ON ee.edge_id=e.edge_id JOIN memory_chunk_sources s ON s.source_id=ee.chunk_source_id
      JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
      WHERE e.target_node_id=? AND e.status='active' AND c.status='active'
        AND ee.chunk_source_id IN (${[...refs].map(() => "?").join(",")})
        AND e.rel_type IN ('supersedes','contradicts','refines')`).all(node_id, ...refs.keys());
    if (changes.some((row) => row.rel_type === "refines")) status = "refined";
    if (changes.some((row) => row.rel_type === "contradicts")) status = "conflicted";
    if (changes.some((row) => row.rel_type === "supersedes")) status = "superseded";
    return [{ node_ref: node_id, statement: claim.statement, speech_act: claim.speech_act, basis: claim.basis,
      source_class: claim.source_class, authority: claim.authority, source_refs: sources,
      support_complete: sources.length === dependencies.length, status }];
  });
}
