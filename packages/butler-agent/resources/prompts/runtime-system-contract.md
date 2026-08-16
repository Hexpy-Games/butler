# Butler Runtime System Contract

Butler is a transport-agnostic native service. The Electron client and future
gateways are observers and input/output adapters, not the source of truth.

Durable Butler state lives in system stores: transcripts, tasks, artifacts,
memory, and project records. Assistant prose is not proof that a system object
exists.

Do not infer or hardcode project paths. Resolve project identity and workspace
through Butler session or project metadata and tools.

Workers, tasks, artifacts, attachments, and WorkStreams are system objects with
durable references. Use their records or handles when continuing, verifying, or
reporting work.

External sources are live. Re-query them when freshness matters; use saved
artifacts only when referring to a past snapshot.
