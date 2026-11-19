import { useCallback, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Badge, Button, ButtonGroup, showToast, Spinner, Surface, Text, useTokens } from "@/ds";
import { nativeFetch } from "@/connection/nativeFetch";
import { probe } from "@/connection/probe";
import type { Problem } from "@/connection/problems";
import { pairingStore } from "@/connection/store";
import { useMobileCopy } from "@/i18n";

type Status = { kind: "checking"; origin?: string } | { kind: "ready"; origin: string } | { kind: "problem"; origin: string; problem: Problem };

export default function Home() {
  const copy = useMobileCopy();
  const t = useTokens();
  const [status, setStatus] = useState<Status>({ kind: "checking" });
  const latest = useRef(0);
  const check = useCallback(async () => {
    const id = ++latest.current;
    setStatus(previous => ({ kind: "checking", origin: previous.origin }));
    const pairing = await pairingStore.loadActive().catch(() => null);
    if (!pairing) {
      if (id !== latest.current) return;
      router.replace("/pair");
      return;
    }
    const result = await probe(pairing.origin, pairing.deviceToken, nativeFetch);
    if (result.kind === "problem" && result.problem === "needsPairing") {
      if (id !== latest.current) return;
      await pairingStore.clear(pairing.butlerId);
      if (id !== latest.current) return;
      showToast({ message: copy.problems.needsPairing, tone: "warning" });
      if (id !== latest.current) return;
      router.replace("/pair");
      return;
    }
    if (id !== latest.current) return;
    setStatus(result.kind === "ready"
      ? { kind: "ready", origin: pairing.origin }
      : { kind: "problem", origin: pairing.origin, problem: result.problem });
  }, [copy]);
  useFocusEffect(useCallback(() => {
    void check();
    return () => { latest.current++; };
  }, [check]));
  return (
    <Surface variant="base" grow edges={["top", "bottom", "left", "right"]} padding="lg">
      <View style={{ flex: 1, gap: t.length("--space-4") }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: t.length("--space-4") }}>
          <Text variant="h1">{copy.appName}</Text>
          {status.origin ? <Text tone="secondary" literal selectable>{status.origin}</Text> : null}
          {status.kind === "checking" ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: t.length("--space-2") }}>
              <Spinner label={copy.home.checking} />
              <Text tone="secondary">{copy.home.checking}</Text>
            </View>
          ) : null}
          {status.kind === "ready" ? (
            <View style={{ flexDirection: "row" }}><Badge tone="success" label={copy.home.connected} /></View>
          ) : null}
          {status.kind === "problem" ? <Text tone="danger">{copy.problems[status.problem]}</Text> : null}
        </ScrollView>
        <ButtonGroup>
          {status.kind === "problem" ? <Button label={copy.home.retry} onPress={check} /> : null}
          <Button variant="secondary" label={copy.home.pairAgain} onPress={() => router.push("/pair")} />
        </ButtonGroup>
      </View>
    </Surface>
  );
}
