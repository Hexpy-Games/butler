import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import type { OperationOutputView } from "@/app/types.ts";
import { Button, Stack, Typo, WorkActivityOutput } from "@/butler-ds";

export function OperationOutputDetails({
  turnId,
  requestId,
  resultId,
  toolName,
}: {
  turnId: string;
  requestId: string;
  resultId: string;
  toolName?: string;
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

  const output = presentOperationOutput(
    toolName,
    pages.map((page) => page.content).join(""),
    latest?.complete === true,
  );

  return (
    <Stack gap="xs">
      {output.kind === "summary" ? (
        <Typo.Caption>{output.content}</Typo.Caption>
      ) : (
        <WorkActivityOutput>{output.content}</WorkActivityOutput>
      )}
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

export function presentOperationOutput(
  toolName: string | undefined,
  content: string,
  complete: boolean,
): { kind: "code" | "summary"; content: string } {
  if (!complete || !isBasicFileTool(toolName)) {
    return { kind: "code", content };
  }
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "code", content };
    }
    value = parsed as Record<string, unknown>;
  } catch {
    return { kind: "code", content };
  }
  if (value.ok !== true) return { kind: "code", content };
  if (toolName === "read_file" && typeof value.content === "string") {
    return { kind: "code", content: value.content };
  }
  const fileName = operationFileName(value.path);
  if (!fileName) return { kind: "code", content };
  const action = toolName === "edit_file" ? "수정 완료" : "작성 완료";
  const byteLabel = typeof value.bytes === "number"
    ? ` · ${new Intl.NumberFormat("ko-KR").format(value.bytes)}바이트`
    : "";
  return { kind: "summary", content: `${action} · ${fileName}${byteLabel}` };
}

function isBasicFileTool(
  value: string | undefined,
): value is "edit_file" | "write_file" | "read_file" {
  return value === "edit_file" || value === "write_file" || value === "read_file";
}

function operationFileName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\\/gu, "/").split("/").filter(Boolean).at(-1) ?? "";
}
