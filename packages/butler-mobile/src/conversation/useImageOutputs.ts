import { useEffect, useRef, useState } from "react";
import { useConversation } from "./live";
import { readImageAssets, type ImageAsset } from "./imageOutputs";

export function useImageOutputs(output?: { turnId: string; callId: string; resultId: string }): ImageAsset[] {
  const { client } = useConversation();
  const turnId = output?.turnId, callId = output?.callId, resultId = output?.resultId;
  const identity = `${turnId}:${callId}:${resultId}`;
  const completed = useRef<string | undefined>(undefined);
  const [state, setState] = useState<{ key: string; images: ImageAsset[] }>({ key: "", images: [] });
  useEffect(() => {
    if (!client || !turnId || !callId || !resultId || completed.current === identity) return;
    const controller = new AbortController();
    setState({ key: identity, images: [] });
    void readImageAssets(client, turnId, callId, resultId, controller.signal).then(images => {
      if (!controller.signal.aborted) {
        completed.current = identity;
        setState({ key: identity, images });
      }
    }, () => { if (!controller.signal.aborted) setState({ key: identity, images: [] }); });
    return () => controller.abort();
  }, [client, turnId, callId, resultId, identity]);
  return state.key === identity ? state.images : [];
}
