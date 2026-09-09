# Dashboard R5 — implementation checkpoint

## Delivered in code

- New conversations persist first among root, project, or group siblings. Existing sibling order is retained; creation refreshes navigation and reveals the new active branch without opening a closed mobile sidebar.
- Dialog close buttons use a circular background without reducing their hit target.
- Work/Plan/Task lanes query ten items independently. Each lane loads ten more using a lane/kind/parent/revision-bound cursor; changing project or kind resets the window.
- The approved document reader is implemented through the public Butler DS. Title/type, factual metadata, Markdown or artifact content, collapsed technical details, and the conversation-reference action are distinct. Copy is centralized in Korean/English. Missing authors, verification and version history are not fabricated. Existing content paging and reference callbacks remain intact.

## Work closeout: demonstrated causes and correction

1. The native Ledger list contract exposed query/status/limit, but command construction omitted them. The CLI serialized all records before parent-side filtering. Large project output exceeded the synchronous process buffer and was misreported as invalid JSON.
   - Filters and limits now reach the CLI and apply before serialization; process failures are classified before parsing. Bounded real-project OAuth lookup succeeds.
2. A completion request was delegated as a new Work. The original project Work is owned by its original Steward, so a replacement Steward cannot mutate that Work's execution manifest.
   - The existing `steer_steward` tool accepts an exact Work ID. Runtime resolves its original relation and owner, validates the admitted source Turn and project binding, and admits only open/blocked Work. Completed/abandoned Work cannot be reopened this way. Work ownership is unchanged.
3. Continuation dispatch tried to bind Work to a Turn before that Turn was admitted. A real App request exposed this failure; control-only mocks did not.
   - Dispatch only persists/enqueues the direction. The existing child admission path binds the original Work after admission. Restart recovery requeues persisted directions idempotently; directions pending before admission share one continuation.
4. Relation-unique results/outbox rows treated a previous report as permanent finality, suppressing a later closeout report.
   - Reports append per applied direction revision. Old reports and outbox identities remain immutable, exact result references keep resolving, and projections/recovery distinguish the latest covered direction. The migration preserves historical rows.

## Verification

- Root and UI TypeScript checks pass.
- Design, CSS and repository lint pass (repository warning-only findings remain).
- Focused placement, grouping, transport, board paging and document view-model checks pass.
- Original-owner followup, cross-project/read-only/terminal rejection, migration, idempotency and restart checks pass.
- The real App POST / production queue / BTCC composition regression passes: initial provider failure, later user acceptance, same relation and Work, original Steward continuation, no repeat file read, canonical Work completion, and second Butler report delivery. The model port is deterministic test input; this is not a live-provider or live-Sandy acceptance claim.
- Actual production document dialog rendered and inspected at desktop, 390px and 320px widths. Reference callback and technical-details disclosure exercised. A clipped mobile footer was corrected and rechecked.
- Broad `app-client-design` source/structural tests still report 12 failures. No full-suite-green claim; baseline comparison is not established. An older broad recovery fixture also rejects its stale direct-delegation plan before the relevant path. Focused migration/recovery checks pass.
- `git diff --check` passes. Module review found cohesive additions; existing large store/service modules remain, with no parallel ownership or completion framework introduced.

## Not yet completed operationally

The live Sandy Work has not been marked completed, and no production restart or deployment is represented by this report. Remaining work is a safe rollout followed by the original owner's review of the user's actual acceptance and any remaining document-publication requirements. The shared checkout contains unrelated local-model and logging changes; they are excluded from this change set. Do not force-complete records through frontmatter or database edits.

## Design references

- [Notion team wiki](https://www.notion.com/help/guides/build-a-docs-first-culture-with-a-beautiful-team-wiki-powered-by-a-database): separate document facts from content.
- [Confluence page properties](https://support.atlassian.com/confluence-cloud/docs/insert-the-page-properties-macro/): structured metadata and identifiable links.
- [Dooray wiki](https://dooray.co.kr/main/en/service/wiki/): readable document hierarchy and document context.

Only metadata available from Butler's current API is represented.
