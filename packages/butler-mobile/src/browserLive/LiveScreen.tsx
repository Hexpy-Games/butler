import { useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { KeyboardAvoidingView, PixelRatio, View, type TextInput } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { Button, ButtonGroup, GlassBackdrop, showToast, Surface, Text } from "@/ds";
import { useAppLocale } from "@/i18n";
import { fit, pageViewport } from "./geometry";
import { InputQueue } from "./input";
import { LiveFrame } from "./LiveFrame";
import { LiveKeyboard } from "./LiveKeyboard";
import { useLiveFrames } from "./useLiveFrames";
import { usePagePointer } from "./usePagePointer";

export function LiveScreen({ tabId, session, request }: { tabId: string; session: string; request: string }) {
  const copy = getAppCopy(useAppLocale());
  const labels = copy.mobile.browserLive;
  const { route, pairing, client } = useConversation();
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [pending, setPending] = useState(false);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const closed = useRef(false);
  const handingBack = useRef(false);
  const dpr = Math.min(PixelRatio.get(), 2);
  const insets = useSafeAreaInsets();
  const { size, uri, status } = useLiveFrames(route, pairing?.deviceToken, tabId, { ...viewport, dpr });
  const box = useMemo(() => size ? fit(stage, size) : null, [stage, size]);
  const queue = useMemo(() => client && new InputQueue(async batch => {
    await client.request(`/browser/tabs/${encodeURIComponent(tabId)}/live/input`, { body: batch });
  }), [client, tabId]);
  const pointer = usePagePointer(uri ? box : null, queue);

  const live = Boolean(uri);
  useEffect(() => {
    if (live && queue && viewport.width) queue.push({ t: "viewport", width: viewport.width, height: viewport.height, dpr });
  }, [live, queue, viewport.width, viewport.height, dpr]);

  useEffect(() => {
    if (status !== "ended" || closed.current) return;
    closed.current = true;
    if (!handingBack.current) showToast({ message: labels.ended });
    router.back();
  }, [status, labels.ended]);

  const done = async () => {
    if (!client || handingBack.current || closed.current) return;
    handingBack.current = true;
    setPending(true);
    try {
      await client.request(`/authority-requests/${encodeURIComponent(request)}/hand-back?session_id=${encodeURIComponent(session)}`, { body: {} });
      if (!closed.current) {
        closed.current = true;
        router.back();
      }
    } catch {
      handingBack.current = false;
      if (!closed.current) showToast({ message: copy.interfaceDetails.decisionFailed, tone: "error" });
    } finally {
      setPending(false);
    }
  };

  // The button bar keeps its bottom safe-area inset, which the keyboard covers: avoid only the rest of the keyboard.
  return <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={-insets.bottom} style={{ flex: 1 }}>
    <GlassBackdrop overlay={
      <Surface padding="md" edges={["bottom", "left", "right"]}>
        <ButtonGroup layout="pair">
          <Button variant="secondary" label={labels.keyboard} disabled={!uri || !queue} onPress={() => {
            if (input.current?.isFocused()) input.current.blur();
            else input.current?.focus();
          }} />
          <Button label={copy.interfaceTemplates.approvalRequest.signInHandoff.done}
            loading={pending} disabled={!client || !session || !request} onPress={() => void done()} />
        </ButtonGroup>
      </Surface>
    }>
      <Surface grow edges={["top", "left", "right"]}>
        <View {...pointer} accessibilityLabel={labels.screen}
          onLayout={({ nativeEvent: { layout: { width, height } } }) => {
            setStage({ width, height });
            setViewport(previous => pageViewport(previous, { width, height }));
          }}
          style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          {uri && box ? <LiveFrame uri={uri} box={box} /> : null}
          {status === "connecting" || status === "failed" ?
            <Text>{status === "failed" ? labels.failed : labels.connecting}</Text> : null}
          {uri && queue ? <LiveKeyboard input={input} queue={queue} /> : null}
        </View>
      </Surface>
    </GlassBackdrop>
  </KeyboardAvoidingView>;
}
