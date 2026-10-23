import { appCopy } from "@/app/copy.ts";
import type { CanonPlan } from "@/app/canonApi.ts";
import { NativeSelect, NativeSelectOption } from "@/butler-ds";
export function CanonPlanSelect({ id, plans, value, disabled, compact, onChange }: {
  id?: string; plans: CanonPlan[]; value: string | null; disabled?: boolean; compact?: boolean; onChange: (value: string | null) => void;
}) {
  return <NativeSelect id={id} size={compact ? "sm" : "default"} aria-label={appCopy.canon.plan} value={value ?? "backlog"} disabled={disabled} onChange={event => onChange(event.target.value === "backlog" ? null : event.target.value)}>
      <NativeSelectOption value="backlog">{appCopy.canon.backlog}</NativeSelectOption>
      {plans.map(plan => <NativeSelectOption key={plan.id} value={plan.id}>{plan.title}</NativeSelectOption>)}
  </NativeSelect>;
}
