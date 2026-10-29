import type { CriteriaCount } from "@/app/canonApi.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { ProgressMeter, Stack } from "@/butler-ds";

export function CriteriaProgress({ criteria }: { criteria?: CriteriaCount | null }) {
  useAppLocale();
  if (!criteria) return null;
  const label = appCopy.canon.criteriaCount(criteria.confirmed, criteria.total);
  return <Stack data-test-class="canon-criteria-progress" gap="none">
    <ProgressMeter value={criteria.confirmed / criteria.total * 100} label={label} meta="" ariaLabel={label} />
  </Stack>;
}
