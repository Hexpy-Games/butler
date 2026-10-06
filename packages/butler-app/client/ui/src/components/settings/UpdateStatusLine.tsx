import { IconSlot, Spinner, Stack, Typo } from "@/butler-ds";

export function UpdateStatusLine({ label }: { label: string }) {
  return <Stack align="row" cross="center" gap="xs" role="status">
    <IconSlot size="sm" tone="secondary"><Spinner size={12} /></IconSlot>
    <Typo.Caption tone="secondary">{label}</Typo.Caption>
  </Stack>;
}
