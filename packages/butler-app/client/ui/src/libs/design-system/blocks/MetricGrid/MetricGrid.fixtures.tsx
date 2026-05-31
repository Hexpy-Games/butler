import { MetricGrid } from "./MetricGrid";
import { MetricCard } from "../MetricCard";

export function MetricGridFixture() {
  return (
    <MetricGrid>
      <MetricCard value="87" label="Active Sessions" />
      <MetricCard value="42" label="Tokens (M)" />
      <MetricCard value="156" label="Projects" />
      <MetricCard value="1.2k" label="Messages" />
    </MetricGrid>
  );
}
