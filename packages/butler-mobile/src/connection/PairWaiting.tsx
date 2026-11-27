import { Text } from "@/ds";
import { useMobileCopy } from "@/i18n";

export function PairWaiting({ matchCode }: { matchCode: string }) {
  const copy = useMobileCopy();
  return (
    <>
      <Text tone="secondary">{copy.pair.matchLabel}</Text>
      <Text variant="h1" numeric="tabular">{matchCode}</Text>
      <Text>{copy.pair.waitHint}</Text>
    </>
  );
}
