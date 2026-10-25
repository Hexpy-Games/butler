/** MetricCard's trend controls color; direction decides whether the delta is favorable. */
export function answerMetricTrend(delta?: string, direction: "up-good" | "down-good" | "neutral" = "up-good"): "up" | "down" | "neutral" {
  const sign = delta?.startsWith("+") ? 1 : delta?.startsWith("-") ? -1 : 0;
  if (!sign || direction === "neutral") return "neutral";
  return (sign > 0) === (direction === "up-good") ? "up" : "down";
}
