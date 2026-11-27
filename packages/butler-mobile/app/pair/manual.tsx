import { ScrollView } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Button, ButtonGroup, Sheet, Surface, Text, TextField, useTokens } from "@/ds";
import { PairWaiting } from "@/connection/PairWaiting";
import { usePairForm } from "@/connection/usePairForm";
import { useMobileCopy } from "@/i18n";

export default function Pair() {
  const copy = useMobileCopy();
  const form = usePairForm(copy, useLocalSearchParams());
  const t = useTokens();
  return (
    <Surface variant="base" grow edges={["top", "bottom", "left", "right"]} padding="lg">
      <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={{ gap: t.length("--space-4") }}>
        <Text variant="h1">{copy.pair.title}</Text>
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
        {form.connecting && form.match && <PairWaiting matchCode={form.match} />}
        <ButtonGroup>
          {form.connecting && form.match
            ? <Button variant="secondary" label={copy.pair.cancel} onPress={form.cancel} />
            : <Button label={copy.pair.connect} onPress={form.connect} loading={form.connecting} testID="pair-connect" />}
        </ButtonGroup>
      </ScrollView>
      <Sheet
        open={form.explainer} onClose={form.closeExplainer} title={copy.localNetwork.title}
        description={copy.localNetwork.body} cancelLabel={copy.localNetwork.cancel}
        action={<Button label={copy.localNetwork.retry} onPress={form.retry} />}
      />
    </Surface>
  );
}
