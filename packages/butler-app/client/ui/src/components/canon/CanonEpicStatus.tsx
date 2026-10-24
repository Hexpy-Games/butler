import type { EpicCard } from "@/app/canonApi.ts";
import { Spinner, Stack } from "@/butler-ds";
import { CanonStatusGlyph } from "./CanonStatusGlyph.tsx";


export function CanonEpicStatus({ epic }: { epic: EpicCard }) {
  return epic.running ? <Spinner size={16} /> : <CanonStatusGlyph status={epic.canon_status} />;
}

/** The Spinner while the epic's conversation is working; nothing otherwise (the board lane shows the status). */
export function CanonEpicActivity({ epic }: { epic: EpicCard }) {
  return epic.running ? <Stack shrink={false}><Spinner size={16} /></Stack> : null;
}
