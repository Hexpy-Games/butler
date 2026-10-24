import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { Inline, MarkdownContent, MarkdownTable, SegmentedControl, Stack, Typo } from "@/butler-ds";
import { useImageUsage } from "../usage/useImageUsage";
import type { ImageUsageValues } from "../usage/imageUsageTypes";
import { ProviderMark } from "./ProviderMark";
import { SettingsSection } from "./SettingsFormComponents";

function ImageUsageCells({ values, locale }: { values: ImageUsageValues; locale: string }) {
  const currency = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const cost = values.estimated_usd;
  const price = cost === null ? "—" : cost > 0 && cost < 0.005 ? "<$0.01" : currency.format(cost);
  const count = new Intl.NumberFormat(locale);
  return <>
    <td><Typo.Text numeric="tabular">{count.format(values.generated)}</Typo.Text></td>
    <td><Typo.Text numeric="tabular">{count.format(values.edited)}</Typo.Text></td>
    <td><Typo.Text numeric="tabular">{price}</Typo.Text></td>
  </>;
}

export function UsageImagesSection({ revision, onRetry }: { revision: number; onRetry: () => void }) {
  const locale = useAppLocale();
  const copy = appCopy.composer.usage;
  const [days, setDays] = useState(7);
  const result = useImageUsage(days, revision);
  if (!result.visible) return null;
  return <SettingsSection id="usage-images" kind="status" title={copy.imagesTitle}
    state={result.error ? "error" : !result.view ? "loading" : "ready"} errorMessage={appCopy.interfacePanels.usageFailed} onRetry={onRetry}>
    <Stack gap="md">
      <Inline><SegmentedControl ariaLabel={`${copy.imagesTitle}: ${copy.period}`} options={[{ value: "7", label: copy.week }, { value: "30", label: copy.month }]}
        value={String(days)} onValueChange={value => setDays(Number(value))} /></Inline>
      {result.view ? <MarkdownContent density="compact"><MarkdownTable aria-label={copy.imagesTitle}>
        <thead><tr><th scope="col" aria-label={copy.models} />
          {[copy.imagesGenerated, copy.imagesEdited, copy.imagesCost].map(label => <th key={label} scope="col"><Typo.Text weight="medium">{label}</Typo.Text></th>)}
        </tr></thead>
        <tbody>{result.view.models.map(model => <tr key={model.model_ref}>
          <th scope="row"><Inline gap="sm" wrap={false} cross="center"><ProviderMark providerId={model.provider_id} /><Typo.Text>{model.display_name}</Typo.Text></Inline></th>
          <ImageUsageCells values={model} locale={locale} />
        </tr>)}</tbody>
        <tfoot><tr><th scope="row"><Typo.Text weight="medium">{copy.imagesTotal}</Typo.Text></th><ImageUsageCells values={result.view.total} locale={locale} /></tr></tfoot>
      </MarkdownTable></MarkdownContent> : null}
    </Stack>
  </SettingsSection>;
}
