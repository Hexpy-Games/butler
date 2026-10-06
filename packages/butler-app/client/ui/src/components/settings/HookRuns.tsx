import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { CardList, DisclosureRow } from "@/butler-ds";
import { RawBlock } from "./DeveloperLogRawBlock";
import { formatTimestamp } from "./developerLogFormat";
import type { HookRun } from "./hooksTypes";

export function HookRuns({ runs }: { runs: HookRun[] }) {
  useAppLocale();
  const copy = appCopy.settings.hooks;
  const [expanded, setExpanded] = useState<number | null>(null);
  return <CardList>{[...runs].reverse().map((run, index) => <DisclosureRow key={`${run.time}-${index}`}
    title={[run.hook_id, run.event, run.outcome === "continue" ? copy.testSuccess : run.outcome === "deny" ? copy.blocked : copy.testFailure].join(" · ")}
    open={expanded === index} onToggle={() => setExpanded(expanded === index ? null : index)}
    description={[formatTimestamp(run.time), run.session_id, `${run.duration_ms} ms`,
      run.exit_code == null ? null : `${copy.exitCode} ${run.exit_code}`].filter(Boolean).join(" · ")}>
    <RawBlock title={run.hook_id} hideTitle value={[run.reason, run.stdout, run.stderr].filter(Boolean).join("\n")} />
  </DisclosureRow>)}</CardList>;
}
