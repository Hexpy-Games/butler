import { useCallback, useState } from "react";
import { ScrollView, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Badge, Button, showToast, Spinner, Surface, Text, useTokens } from "@/ds";
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
  const check = useCallback(async () => {
    setStatus(previous => ({ kind: "checking", origin: previous.origin }));
    const pairing = await pairingStore.loadActive().catch(() => null);
    if (!pairing) {
      router.replace("/pair");
      return;
    }
    const result = await probe(pairing.origin, pairing.deviceToken, nativeFetch);
    if (result.kind === "problem" && result.problem === "needsPairing") {
      await pairingStore.clear(pairing.butlerId);
      showToast({ message: copy.problems.needsPairing, tone: "warning" });
      router.replace("/pair");
      return;
    }
    setStatus(result.kind === "ready"
      ? { kind: "ready", origin: pairing.origin }
      : { kind: "problem", origin: pairing.origin, problem: result.problem });
  }, [copy]);
  useFocusEffect(useCallback(() => { void check(); }, [check]));
  return (
    <Surface variant="base" grow edges={["top", "bottom", "left", "right"]} padding="lg">
      <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={{ gap: t.length("--space-4") }}>
        <View style={{ gap: t.length("--space-4") }}>
          <Text variant="h3">{copy.appName}</Text>
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
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: t.length("--space-2"), flexWrap: "wrap" }}>
            <Button variant="secondary" label={copy.home.pairAgain} onPress={() => router.push("/pair")} />
            {status.kind === "problem" ? <Button label={copy.home.retry} onPress={check} /> : null}
          </View>
        </View>
      </ScrollView>
    </Surface>
  );
}
