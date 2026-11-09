import { useButlerStore } from "@/app/store";
import type { MessageRecord, ProgressRow } from "@/app/types";
import { Stack } from "@/butler-ds";
import { GeneratedImageCard } from "./GeneratedImageCard";
import { useImageOutputs } from "./useImageOutputs";

const EMPTY: ProgressRow[] = [];
export function TurnGeneratedImages({ turnId, rows, revision, session, title }: { turnId?: string; rows: ProgressRow[]; revision?: string; session: string; title: string }) {
  const { images } = useImageOutputs(turnId, rows, revision);
  if (!images.length) return null;
  return <Stack gap="md">{images.map((asset, index) => <GeneratedImageCard key={`${asset.id}-${index}`} asset={asset}
    images={images} title={title} index={index} session={session} />)}</Stack>;
}
export function GeneratedImages({ message }: { message: MessageRecord }) {
  const live = useButlerStore(s => message.turn_id ? s.turnProgress[message.turn_id]?.safe_progress_rows : undefined);
  const request = useButlerStore(s => s.messages.find(m => m.role === "user" && m.turn_id === message.turn_id)?.text ?? "");
  const title = Array.from(request.split(/\r?\n/u)[0]).slice(0, 80).join("");
  return <TurnGeneratedImages turnId={message.turn_id} rows={message.turn_activity_rows ?? live ?? EMPTY}
    revision={`${message.status}:${message.updated_at}`} session={message.chat_id ?? ""} title={title} />;
}
