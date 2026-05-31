import * as React from "react";
import * as RechartsPrimitive from "recharts";
import { cn } from "../../lib/utils";
import styles from "../../components/Chart/Chart.module.css";

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    color?: string;
    icon?: React.ComponentType;
  }
>;

interface ChartContextValue {
  config: ChartConfig;
}

interface ChartContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  config: ChartConfig;
  initialDimension?: {
    width: number;
    height: number;
  };
  children: React.ReactElement;
}

interface ChartStyleProps {
  id: string;
  config: ChartConfig;
}

interface TooltipPayload {
  dataKey?: string | number;
  name?: string | number;
  value?: unknown;
  color?: string;
  payload?: Record<string, unknown>;
}

interface ChartTooltipContentProps {
  active?: boolean;
  payload?: TooltipPayload[];
  className?: string;
  hideLabel?: boolean;
  label?: string | number;
  formatter?: (
    value: unknown,
    name: string | number,
    item: TooltipPayload,
    index: number,
  ) => React.ReactNode;
  nameKey?: string;
  labelKey?: string;
}

const INITIAL_DIMENSION = {
  width: 320,
  height: 200,
};

const ChartContext = React.createContext<ChartContextValue | null>(null);

function useChart() {
  const context = React.useContext(ChartContext);
  if (!context) {
    throw new Error("useChart must be used within a <ChartContainer />");
  }
  return context;
}

export function ChartContainer({
  id,
  className,
  children,
  config,
  initialDimension = INITIAL_DIMENSION,
  ...props
}: ChartContainerProps) {
  const uniqueId = React.useId();
  const chartId = `chart-${id ?? uniqueId.replace(/:/g, "")}`;

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        className={cn(styles.chart, className)}
        data-chart={chartId}
        data-slot="chart"
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer
          initialDimension={initialDimension}
        >
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export function ChartStyle({ id, config }: ChartStyleProps) {
  const colorConfig = Object.entries(config).filter(([, item]) =>
    Boolean(item.color),
  );
  if (colorConfig.length === 0) return null;

  const css = colorConfig
    .map(([key, item]) =>
      item.color ? `  --color-${key}: ${item.color};` : null,
    )
    .filter(Boolean)
    .join("\n");

  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `[data-chart=${id}] {\n${css}\n}`,
      }}
    />
  );
}

export const ChartTooltip = RechartsPrimitive.Tooltip;
export const ChartLegend = RechartsPrimitive.Legend;

export function ChartTooltipContent({
  active,
  payload,
  className,
  hideLabel = false,
  label,
  formatter,
  nameKey,
  labelKey,
}: ChartTooltipContentProps) {
  const { config } = useChart();
  if (!active || !payload?.length) return null;

  const firstPayload = payload[0];
  const titleKey = String(
    labelKey ?? firstPayload?.dataKey ?? firstPayload?.name ?? label ?? "value",
  );
  const title = hideLabel ? null : (config[titleKey]?.label ?? label);

  return (
    <div className={cn(styles.tooltip, className)}>
      {title && <strong>{title}</strong>}
      <div className={styles.tooltipList}>
        {payload.map((item, index) => {
          const key = String(nameKey ?? item.name ?? item.dataKey ?? "value");
          const labelNode = config[key]?.label ?? item.name ?? item.dataKey;
          const color =
            item.color ?? config[key]?.color ?? `var(--color-${key})`;
          return (
            <div className={styles.tooltipRow} key={`${key}-${index}`}>
              <span
                className={styles.tooltipSwatch}
                style={{ backgroundColor: color }}
              />
              <span>{labelNode}</span>
              <strong>
                {formatter
                  ? formatter(item.value, key, item, index)
                  : formatTooltipValue(item.value)}
              </strong>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ChartLegendContent() {
  return null;
}

function formatTooltipValue(value: unknown): string {
  if (typeof value === "number") return value.toLocaleString();
  if (typeof value === "string") return value;
  return "";
}
