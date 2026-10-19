import { appCopy } from "@/app/copy.ts";
import { CopyButton, Inline, Stack } from "@/butler-ds";
import { RawBlock } from "../DeveloperLogRawBlock";
import { prettyJson } from "./logFormat";
import type { LogRecord } from "./logsApi";

/** The record as returned, with a copy action. */
export function LogJson({ record }: { record: LogRecord }) {
  const copy = appCopy.settings.logs;
  const text = prettyJson(record);
  return (
    <Stack gap="xs">
      <RawBlock title={copy.tabs.json} value={text} hideTitle />
      <Inline justify="end">
        <CopyButton label={copy.copyJson} copiedLabel={copy.copied} text={text} />
      </Inline>
    </Stack>
  );
}
