import { useEffect, useRef } from "react";
import { appCopy } from "@/app/copy.ts";
import { Button } from "@/butler-ds";
import { useLogListView } from "@/stores/logListStore.ts";
import { LogRow } from "./LogRow";
import { recordKey } from "./logRecords";
import type { LogViewerState } from "./useLogViewer";

/** 로그's rows, newest first, with 더 보기 for the next page. */
export function LogRows({ viewer }: { viewer: LogViewerState }) {
  const openKey = useLogListView((state) => state.openKey);
  const toggleRow = useLogListView((state) => state.toggleRow);
  useOpenRowAnchor(openKey, viewer.rows.length);
  return (
    <>
      {viewer.rows.map((record) => {
        const key = recordKey(record);
        return <LogRow key={key} record={record} open={openKey === key} onToggle={() => toggleRow(key)} />;
      })}
      {viewer.hasMore ? (
        <Button type="button" size="sm" variant="outline" disabled={viewer.loading} onClick={viewer.loadMore}>
          {appCopy.common.more}
        </Button>
      ) : null}
    </>
  );
}

/** Back from 메시지 추적: the row left open comes back into view once its page arrives. */
function useOpenRowAnchor(openKey: string | null, rows: number) {
  const pending = useRef(openKey !== null);
  useEffect(() => {
    if (!pending.current || rows === 0) return;
    const row = document.querySelector('[data-test-class="log-row"][data-log-open="true"]');
    if (!row) return;
    pending.current = false;
    row.scrollIntoView({ block: "center" });
  }, [openKey, rows]);
}
