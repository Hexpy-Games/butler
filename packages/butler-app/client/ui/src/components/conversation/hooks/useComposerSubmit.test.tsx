import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useComposerSubmit } from "./useComposerSubmit";
import { useButlerStore } from "@/app/store.ts";
import { useComposerStore } from "../composerStore";
import type { ComposerControls } from "@/app/types.ts";

test("offline form/Enter and store sends preserve the draft; recovery does not auto-send", async () => {
  const previous = useComposerStore.getState();
  const lost = useButlerStore.getState().liveConnectionLost;
  let submit: ReturnType<typeof useComposerSubmit>;
  const sent: string[] = [];
  let accepted: ComposerControls["onAccepted"];
  function Harness() {
    submit = useComposerSubmit({ text: "Keep this draft", setText: useComposerStore.getState().setText,
      attachments: [], setAttachments: () => {}, isSending: false, activeTurn: false, uploadingCount: 0,
      model: "test-model", reasoning: "medium", accessMode: "full_access", planMode: false, controlsTouched: false,
      setModelMenuOpen: () => {}, setAccessMenuOpen: () => {},
      onSend: (text, controls) => { sent.push(text); accepted = controls.onAccepted; } });
    return null;
  }
  try {
    useComposerStore.getState().setText("Keep this draft");
    useButlerStore.setState({ liveConnectionLost: true });
    renderToStaticMarkup(<Harness />);
    submit!({ key: "Enter", preventDefault() {} });
    await useButlerStore.getState().sendMessage("Must not be sent");
    expect(sent).toEqual([]);
    expect(useComposerStore.getState().text).toBe("Keep this draft");
    useButlerStore.setState({ liveConnectionLost: false });
    expect(sent).toEqual([]);
    submit!({ key: "Enter", preventDefault() {} });
    expect(sent).toEqual(["Keep this draft"]);
    accepted?.();
    expect(useComposerStore.getState().text).toBe("");
  } finally { useComposerStore.setState(previous); useButlerStore.setState({ liveConnectionLost: lost }); }
});
