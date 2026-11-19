import { ScrollView, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Button, Sheet, Surface, Text, TextField, useTokens } from "@/ds";
import { usePairForm } from "@/connection/usePairForm";
import { useMobileCopy } from "@/i18n";

export default function Pair() {
  const copy = useMobileCopy();
  const form = usePairForm(copy, useLocalSearchParams());
  const t = useTokens();
  return (
    <Surface variant="base" grow edges={["top", "bottom", "left", "right"]} padding="lg">
      <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={{ gap: t.length("--space-4") }}>
        <Text variant="h3">{copy.pair.title}</Text>
        <Text tone="secondary">{copy.pair.lede}</Text>
        <TextField
          label={copy.pair.address} value={form.address} onChangeText={form.setAddress} error={form.addressError}
          disabled={form.connecting} literal keyboardType="url" autoComplete="url" returnKeyType="next" testID="pair-address"
        />
        <TextField
          label={copy.pair.code} value={form.code} onChangeText={form.setCode} error={form.codeError}
          disabled={form.connecting} numeric="tabular" keyboardType="number-pad" autoComplete="one-time-code"
          returnKeyType="go" onSubmitEditing={form.connect} testID="pair-code"
        />
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <Button label={copy.pair.connect} onPress={form.connect} loading={form.connecting} testID="pair-connect" />
        </View>
      </ScrollView>
      <Sheet
        open={form.explainer} onClose={form.closeExplainer} title={copy.localNetwork.title}
        description={copy.localNetwork.body} closeLabel={copy.localNetwork.close}
        actions={<Button label={copy.localNetwork.retry} onPress={form.retry} />}
      />
    </Surface>
  );
}
