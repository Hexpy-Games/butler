import { MetricCard } from "./MetricCard";
import { Stack } from "../../components/Stack";
import { Activity } from "../../components/Icons";

export function MetricCardFixture() {
  return (
    <Stack gap="2">
      <MetricCard
        value="87"
        label="Active Sessions"
        trend="up"
        change="+12%"
        icon={<Activity size={16} />}
      />
      <MetricCard
        value="42"
        label="Tokens Used (M)"
        trend="down"
        change="-8%"
        icon={<Activity size={16} />}
      />
      <MetricCard
        value="156"
        label="Total Projects"
      />
    </Stack>
  );
}
