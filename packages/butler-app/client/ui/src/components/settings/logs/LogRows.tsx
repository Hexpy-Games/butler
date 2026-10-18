import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { Button } from "@/butler-ds";
import { LogRow } from "./LogRow";
import type { LogRecord } from "./logsApi";
import type { LogViewerState } from "./useLogViewer";

/** 로그's rows, newest first, with 더 보기 for the next page. */
export function LogRows({ viewer }: { viewer: LogViewerState }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const keys = rowKeys(viewer.rows);
  return (
    <>
      {viewer.rows.map((record, index) => {
        const key = keys[index]!;
        return <LogRow key={key} record={record} open={openKey === key}
          onToggle={() => setOpenKey((current) => current === key ? null : key)} />;
      })}
      {viewer.hasMore ? (
        <Button type="button" size="sm" variant="outline" disabled={viewer.loading} onClick={viewer.loadMore}>
          {appCopy.common.more}
        </Button>
      ) : null}
    </>
  );
}

/** Records have no id; time, category, event and span name one, numbered on collisions. */
function rowKeys(rows: readonly LogRecord[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const base = `${row.ts}|${row.category}|${row.event}|${row.span_id ?? ""}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}#${count}`;
  });
}
