import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import type { OperationOutputView } from "@/app/types.ts";
import { Button, Stack, Typo, WorkActivityOutput } from "@/butler-ds";

export function OperationOutputDetails({
  turnId,
  requestId,
  resultId,
}: {
  turnId: string;
  requestId: string;
  resultId: string;
}) {
  const [pages, setPages] = useState<OperationOutputView[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const latest = pages.at(-1);

  useEffect(() => {
    let active = true;
    void readPage(0).then(
      (page) => {
        if (!active) return;
        setPages([page]);
        setState("ready");
      },
      () => {
        if (active) setState("failed");
      },
    );
    return () => {
      active = false;
    };
  }, [turnId, requestId, resultId]);

  async function readPage(offset: number): Promise<OperationOutputView> {
    return await api<OperationOutputView>(
      `/turns/${encodeURIComponent(turnId)}/operations/${encodeURIComponent(requestId)}` +
        `/output?result_id=${encodeURIComponent(resultId)}&offset=${offset}`,
    );
  }

  async function loadMore(): Promise<void> {
    if (!latest || latest.complete || state === "loading") return;
    setState("loading");
    try {
      const page = await readPage(latest.byte_end);
      setPages((current) => [...current, page]);
      setState("ready");
    } catch {
      setState("failed");
    }
  }

  if (state === "failed" && pages.length === 0) {
    return <Typo.Caption>도구 출력을 불러오지 못했습니다.</Typo.Caption>;
  }

  return (
    <Stack gap="xs">
      <WorkActivityOutput>{pages.map((page) => page.content).join("")}</WorkActivityOutput>
      {latest && !latest.complete ? (
        <Button
          disabled={state === "loading"}
          onClick={() => void loadMore()}
          size="xs"
          text={state === "loading" ? "불러오는 중" : "출력 더 보기"}
          type="button"
          variant="borderless"
        />
      ) : null}
    </Stack>
  );
}
