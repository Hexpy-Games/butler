import { useState } from "react";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  NavRow,
  ScrollArea,
  Stack,
  Typo,
} from "@/butler-ds";
import { requestSpaceMove } from "@/app/space/move";
import { canDrop } from "@/app/space/drag";
import type { SpaceRowData } from "@/app/space/projection";
import { SpaceGlyph } from "./SpaceIdentity";

export function SpaceMoveForm({
  sourceKey,
  rows,
}: {
  sourceKey: string;
  rows: Map<string, SpaceRowData>;
}) {
  const [query, setQuery] = useState("");
  const candidates = [...rows.values()].filter(
    (r) =>
      r.node.kind !== "session" &&
      `${r.title} ${r.location}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()) &&
      canDrop(rows, sourceKey, r.node.key, "inside"),
  );
  return (
    <Stack gap="4">
      <DialogHeader>
        <DialogTitle>이동할 위치</DialogTitle>
        <DialogDescription>
          대화와 파일은 유지하고 정리 위치를 변경합니다.
        </DialogDescription>
      </DialogHeader>
      <Input
        aria-label="그룹 또는 프로젝트 검색"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ScrollArea>
        <Stack gap="1">
          {canDrop(rows, sourceKey, null, "inside") && (
            <NavRow
              label="스페이스 최상위"
              onClick={() => {
                requestSpaceMove(rows, sourceKey, null, "inside");
              }}
            />
          )}
          {candidates.map((row) => (
            <NavRow
              key={row.node.key}
              icon={<SpaceGlyph row={row} />}
              label={row.title}
              onClick={() => {
                requestSpaceMove(rows, sourceKey, row.node.key, "inside");
              }}
            />
          ))}
          {!candidates.length && query && (
            <Typo.Caption>일치하는 위치가 없습니다.</Typo.Caption>
          )}
        </Stack>
      </ScrollArea>
    </Stack>
  );
}
