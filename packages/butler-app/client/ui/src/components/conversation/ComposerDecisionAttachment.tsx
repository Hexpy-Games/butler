import { Box, Button, FileText, Stack, Typo } from "@/butler-ds";

/** The pill above the Composer that reopens a decision document (a plan, a request). */
export function ComposerDecisionAttachment({ title, label, onShowDecision, testClass }: {
  title: string; label: string; onShowDecision: () => void; testClass?: string;
}) {
  return <Box paddingX="lg" paddingY="xs" data-test-class={testClass}>
    <Button type="button" variant="outline" size="xs" shape="pill" aria-label={title} onClick={onShowDecision}
      iconStart={<FileText aria-hidden="true" size="sm" />}
      text={<Stack as="span" align="row" cross="center" gap="xs" minWidth="0">
        <Typo.Label as="span" weight="regular" tone="primary" truncate>{title}</Typo.Label>
        <Typo.Caption tone="tertiary" wrap="nowrap">{label}</Typo.Caption>
      </Stack>} />
  </Box>;
}
