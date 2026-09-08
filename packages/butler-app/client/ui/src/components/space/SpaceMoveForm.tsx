import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
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
  useAppLocale();
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
        <DialogTitle>{appCopy.space.moveDestination}</DialogTitle>
        <DialogDescription>
          {appCopy.space.moveDescription}</DialogDescription>
      </DialogHeader>
      <Input
        aria-label={appCopy.space.searchDestination}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ScrollArea>
        <Stack gap="1">
          {canDrop(rows, sourceKey, null, "inside") && (
            <NavRow
              label={appCopy.space.root}
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
            <Typo.Caption>{appCopy.space.noDestination}</Typo.Caption>
          )}
        </Stack>
      </ScrollArea>
    </Stack>
  );
}
