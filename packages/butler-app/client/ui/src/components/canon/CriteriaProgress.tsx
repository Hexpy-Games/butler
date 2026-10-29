import type { CriteriaCount } from "@/app/canonApi.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { ProgressMeter, Stack } from "@/butler-ds";

export function CriteriaProgress({ criteria, label }: { criteria?: CriteriaCount | null; label?: string }) {
  useAppLocale();
  if (!criteria) return null;
  const count = appCopy.canon.criteriaCount(criteria.confirmed, criteria.total);
  return <Stack data-test-class="canon-criteria-progress" gap="none">
    <ProgressMeter value={criteria.total ? criteria.confirmed / criteria.total * 100 : 0}
      label={label ?? count} meta={label === undefined ? "" : count} ariaLabel={count} />
  </Stack>;
}
