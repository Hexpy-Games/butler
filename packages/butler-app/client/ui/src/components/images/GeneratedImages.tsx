import { useButlerStore } from "@/app/store";
import type { MessageRecord, ProgressRow } from "@/app/types";
import { Stack } from "@/butler-ds";
import { GeneratedImageCard } from "./GeneratedImageCard";
import { useImageOutputs } from "./useImageOutputs";

const EMPTY: ProgressRow[] = [];
export function GeneratedImages({ message }: { message: MessageRecord }) {
  const live = useButlerStore(s => message.turn_id ? s.turnProgress[message.turn_id]?.safe_progress_rows : undefined);
  const { images } = useImageOutputs(message.turn_id, message.turn_activity_rows ?? live ?? EMPTY, `${message.status}:${message.updated_at}`);
  const request = useButlerStore(s => s.messages.find(m => m.role === "user" && m.turn_id === message.turn_id)?.text ?? "");
  const title = Array.from(request.split(/\r?\n/u)[0]).slice(0, 80).join("");
  if (!images.length) return null;
  return <Stack gap="md">{images.map((asset, index) => <GeneratedImageCard key={`${asset.id}-${index}`} asset={asset}
    images={images} title={title} index={index} session={message.chat_id ?? ""} />)}</Stack>;
}
