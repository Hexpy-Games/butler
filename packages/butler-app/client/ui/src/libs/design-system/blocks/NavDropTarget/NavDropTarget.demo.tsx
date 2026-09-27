import { useMemo, useState, type DragEvent } from "react";
import { CollapsibleList } from "../../components/Collapsible";
import { MessageSquare } from "../../components/Icons";
import { createDropZoneTracker, measureDropBox, type DropZoneHit } from "../../lib/dropZones";
import { NavRow } from "../NavRow";
import { NavDropScope, NavDropTarget } from "./NavDropTarget";

/** Header box of a 30px comfortable row. */
const HEADER = { top: 0, height: 30 };

type DemoRow = { id: string; label: string; group?: string };

/**
 * Real native drag and drop: drop zones are hit-tested on layout boxes with
 * hysteresis and a dwell before grouping (lib/dropZones), so moving slowly
 * across a row changes the feedback once per boundary.
 */
export function InteractiveDropDemo({ labels, groupHint, groupedWith }: { labels: readonly string[]; groupHint: string; groupedWith: string }) {
  const [rows, setRows] = useState<DemoRow[]>(() => labels.map((label, index) => ({ id: `row-${index}`, label })));
  const [source, setSource] = useState<string | null>(null);
  const [hit, setHit] = useState<DropZoneHit<string> | null>(null);
  const tracker = useMemo(() => createDropZoneTracker<string>({ onChange: setHit }), []);

  function over(event: DragEvent<HTMLElement>) {
    if (!source) return;
    event.preventDefault();
    const scope = event.currentTarget;
    const candidates = [...scope.querySelectorAll<HTMLElement>("[data-demo-row]")].flatMap((item) => {
      const key = item.dataset.demoRow!;
      const header = (item.firstElementChild as HTMLElement | null) ?? item;
      return key === source ? [] : [{ key, ...measureDropBox(header, scope), combine: true }];
    });
    tracker.update(event.clientY, candidates, event.timeStamp);
  }

  function finish(commit: boolean) {
    if (commit && source && hit) {
      setRows((current) => {
        const moving = current.find((row) => row.id === source)!;
        const target = current.find((row) => row.id === hit.key)!;
        if (hit.zone === "combine") return current.map((row) => (row.id === source ? { ...row, group: target.label } : row));
        const rest = current.filter((row) => row.id !== source);
        const index = rest.findIndex((row) => row.id === hit.key) + (hit.zone === "after" ? 1 : 0);
        return [...rest.slice(0, index), moving, ...rest.slice(index)];
      });
    }
    tracker.reset();
    setHit(null);
    setSource(null);
  }

  return (
    <NavDropScope
      active={source !== null}
      aria-label="Interactive rows"
      data-ds-drag-demo=""
      onDragOver={over}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) tracker.reset();
      }}
      onDrop={(event) => {
        event.preventDefault();
        finish(true);
      }}
    >
      <CollapsibleList scope="interactive">
        {rows.map((row) => {
          const drop = hit?.key === row.id ? (hit.zone === "combine" ? "group" : hit.zone) : undefined;
          return (
            <NavDropTarget
              key={row.id}
              data-demo-row={row.id}
              draggable
              drop={drop}
              dragging={source === row.id}
              indicator={HEADER}
              hint={groupHint}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", row.id);
                setSource(row.id);
              }}
              onDragEnd={() => finish(false)}
            >
              <NavRow
                icon={<MessageSquare />}
                label={row.label}
                meta={row.group ? `${groupedWith} ${row.group}` : undefined}
                onClick={() => undefined}
              />
            </NavDropTarget>
          );
        })}
      </CollapsibleList>
    </NavDropScope>
  );
}
