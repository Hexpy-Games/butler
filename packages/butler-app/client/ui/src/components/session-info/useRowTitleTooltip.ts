import { useRef, useState } from "react";
import { appCopy } from "@/app/copy.ts";

/** At rest the row tooltip names the action; a cut title shows in full instead. */
export function useRowTitleTooltip(title: string) {
  const titleRef = useRef<HTMLElement>(null);
  const [truncated, setTruncated] = useState(false);
  const measure = () => setTruncated(Boolean(titleRef.current && titleRef.current.scrollWidth > titleRef.current.clientWidth));
  return { titleRef, measure, label: truncated ? title : appCopy.interfaceDetails.progressDetails, wrap: truncated };
}
