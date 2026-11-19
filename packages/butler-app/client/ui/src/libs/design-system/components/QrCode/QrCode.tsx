import { useMemo, type HTMLAttributes } from "react";
import { encode } from "uqr";
import type { DsBaseProps } from "../../lib/dsProps";
import { cn } from "../../lib/utils";
import styles from "./QrCode.module.css";

export interface QrCodeProps extends DsBaseProps<HTMLAttributes<HTMLDivElement>> {
  /** The text to encode, such as a pairing link. */
  value: string;
  /** Accessible name; the code itself is not readable text. */
  label: string;
}

/**
 * A scannable QR code: dark modules on a white tile with the standard
 * 4-module quiet zone, identical in light and dark themes so every camera reads it.
 */
export function QrCode({ value, label, className, ...props }: QrCodeProps) {
  const { size, d } = useMemo(() => modules(value), [value]);
  return (
    <div className={cn(styles.tile, className)} data-slot="qr-code" {...props}>
      <svg role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges">
        <path d={d} />
      </svg>
    </div>
  );
}

/** One path of 1×1 squares, one per dark module. */
function modules(value: string) {
  const { size, data } = encode(value, { ecc: "M", border: 4 });
  let d = "";
  data.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x} ${y}h1v1h-1z`; }));
  return { size, d };
}
