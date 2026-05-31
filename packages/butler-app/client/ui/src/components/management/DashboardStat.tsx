import { MetricCard } from "@/butler-ds";

export function DashboardStat({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return <MetricCard label={label} value={value} />;
}
