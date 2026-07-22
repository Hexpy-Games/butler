import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ProjectLedgerCorePublication } from "./contracts.ts";
import type { ProjectLedgerCore } from "./project-ledger-core.ts";

type Journal = ProjectLedgerCorePublication & {
  status: "claim_pending" | "preparing" | "prepared" | "committing" | "promoted" | "observed";
};

export function reconcileOrphanedPublications(
  core: ProjectLedgerCore,
  stagingRoot: string,
  referencedPublicationIds: ReadonlySet<string>,
): void {
  const journalsRoot = join(stagingRoot, "journals");
  if (!existsSync(journalsRoot)) return;
  for (const name of readdirSync(journalsRoot).sort()) {
    if (!name.endsWith(".json")) continue;
    const journal = JSON.parse(readFileSync(join(journalsRoot, name), "utf8")) as Journal;
    const referenced = referencedPublicationIds.has(journal.publicationId) || journal.status === "observed";
    if (journal.status !== "claim_pending" && journal.status !== "preparing" && journal.status !== "prepared") {
      if (!referenced) {
        throw new Error(
          `Unreferenced Project Ledger publication requires operator diagnosis: ${journal.publicationId}`,
        );
      }
    }
    core.reconcilePublicationClaim(journal.claimPath, journal, referenced);
    if (referenced) continue;
    rmSync(journal.candidateRoot, { recursive: true, force: true });
    rmSync(journal.journalPath, { force: true });
  }
}
