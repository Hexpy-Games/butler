import { useEffect, useMemo, useState, type ReactNode } from "react";
import { InspectorInset } from "@/butler-ds";
import type { TaskGraph } from "./fixture";
import { GraphCanvas } from "./GraphCanvas";
import { GraphLanes } from "./GraphLanes";
import { indexGraph, layeredColumns } from "./layout";

export function usePhone() {
  const query = "(width <= 640px)";
  const [phone, setPhone] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setPhone(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return phone;
}

export interface OneGraphProps {
  graph: TaskGraph;
  label: string;
  selected: string | null;
  renderCard: (id: string) => ReactNode;
  onSelect: (id: string) => void;
  /** Combined layout on desktop: no own ScrollArea. */
  bare?: boolean;
}

/** One graph: a left-to-right canvas on desktop, inset top-to-bottom lanes on a phone. */
export function GraphView({ graph, label, selected, renderCard, onSelect, bare }: OneGraphProps) {
  const phone = usePhone();
  const index = useMemo(() => indexGraph(graph), [graph]);
  const columns = useMemo(() => layeredColumns(graph, index), [graph, index]);
  const view = { graph, index, columns, label, selected, renderCard, onSelect };
  return phone
    ? <InspectorInset><GraphLanes {...view} /></InspectorInset>
    : <GraphCanvas {...view} bare={bare} />;
}
