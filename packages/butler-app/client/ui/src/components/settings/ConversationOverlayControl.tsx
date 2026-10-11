import { useEffect, useRef, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { Label, Slider, Stack } from "@/butler-ds";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";

/** Overlay is a local preview until the native pointer/key release. */
export function ConversationOverlayControl({ value }: { value: number }) {
  const [preview, setPreview] = useState(value);
  const latest = useRef(value);
  const dirty = useRef(false);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  useEffect(() => {
    if (!dirty.current) { latest.current = value; setPreview(value); }
  }, [value]);
  const save = () => {
    if (!dirty.current) return;
    dirty.current = false;
    void update({ conversation_background: { overlay: latest.current } }, setSettings);
  };
  const label = `${appCopy.settings.fields.conversationOverlay} ${preview}%`;
  return <Stack gap="sm">
    <Label htmlFor="conversation-overlay">{label}</Label>
    <Slider id="conversation-overlay" aria-label={label} min={0} max={95} step={5} value={preview}
      onValueChange={(next) => { latest.current = next; dirty.current = true; setPreview(next); }}
      onPointerUp={save} onKeyUp={save} />
  </Stack>;
}
