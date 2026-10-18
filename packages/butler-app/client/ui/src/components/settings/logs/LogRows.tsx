import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { Button } from "@/butler-ds";
import { LogRow } from "./LogRow";
import { recordKey } from "./logRecords";
import type { LogViewerState } from "./useLogViewer";

/** 로그's rows, newest first, with 더 보기 for the next page. */
export function LogRows({ viewer }: { viewer: LogViewerState }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  return (
    <>
      {viewer.rows.map((record) => {
        const key = recordKey(record);
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
