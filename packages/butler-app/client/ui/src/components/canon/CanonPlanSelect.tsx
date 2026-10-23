import { appCopy } from "@/app/copy.ts";
import type { CanonPlan } from "@/app/canonApi.ts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/butler-ds";
export function CanonPlanSelect({ id, plans, value, disabled, onChange }: {
  id?: string; plans: CanonPlan[]; value: string | null; disabled?: boolean; onChange: (value: string | null) => void;
}) {
  return <Select value={value ?? "backlog"} disabled={disabled} onValueChange={value => onChange(value === "backlog" ? null : value)}>
    <SelectTrigger id={id} aria-label={appCopy.canon.plan}><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectItem value="backlog">{appCopy.canon.backlog}</SelectItem>
      {plans.map(plan => <SelectItem key={plan.id} value={plan.id}>{plan.title}</SelectItem>)}
    </SelectContent>
  </Select>;
}
