import { View } from "react-native";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { Button, ButtonGroup, Surface, Text, useTokens } from "@/ds";
import { parsePairLink, type PairLinkParams } from "@/connection/pairLink";
import { useMobileCopy } from "@/i18n";

export default function PairChoice() {
  const copy = useMobileCopy();
  const t = useTokens();
  const { v, a, c } = useLocalSearchParams<PairLinkParams>();
  if (parsePairLink({ v, a, c })) {
    const params = Object.fromEntries(Object.entries({ v, a, c }).filter(([, value]) => value !== undefined));
    return <Redirect href={{ pathname: "/pair/manual", params }} />;
  }
  return (
    <Surface variant="base" grow edges={["top", "bottom", "left", "right"]} padding="lg">
      <View style={{ flex: 1, justifyContent: "space-between", gap: t.length("--space-4") }}>
        <View style={{ gap: t.length("--space-4") }}>
          <Text variant="h1">{copy.pair.title}</Text>
          <Text tone="secondary">{copy.pair.choiceLede}</Text>
        </View>
        <ButtonGroup>
          <Button label={copy.pair.scan} onPress={() => router.push("/pair/scan")} testID="pair-scan" />
          <Button label={copy.pair.manual} variant="secondary" onPress={() => router.push("/pair/manual")} testID="pair-manual" />
        </ButtonGroup>
      </View>
    </Surface>
  );
}
