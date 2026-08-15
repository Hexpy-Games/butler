# operations

`packages/butler-agent/src/operations/` contains operational state, supervision, diagnostics, and
release/install helpers used by the runtime, CLI, gateway, and maintenance jobs.

## Key Files

- `service/`: automation store, native service supervisor, foreground service
  daemon, and OS service adapter.
- `scheduler/`: native scheduler runtime.
- `health/`: delivery backlog and recoverable task health.
- `metrics/`: raw-text-free context, operational, and usage metrics.
- `gateway/`: agent-owned gateway registry, settings, and safe status helpers.
- `install/`: installer and upgrade helpers.
- `release/`: release manifest and packaging gates.
- `tunnel/`: repository-owned bounded HTTP/HTTPS tunnel proxy and lifecycle
  entrypoint. It receives credentials and upstream targets through typed
  configuration or environment variables rather than private files.

## Boundaries

Operational modules may summarize private systems, but they must not store or
emit raw prompts, raw messages, credentials, raw tool payloads, raw URLs, or
private memory text.

## Related Specs

- `SPEC-OPERATIONAL-METRICS-AND-CLI` - Operational Metrics And CLI
- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
- `SPEC-AGENTIC-CORE-AUTOMATION` - Agentic Core AC-4 Automation
- `SPEC-AGENTIC-CORE-USAGE-MONITORING` - Agentic Core AC-3 Usage Monitoring
- `SPEC-AGENTIC-CORE-CONTEXT-MONITORING` - Agentic Core AC-2 Context Monitoring
- `SPEC-OS-SERVICE-ADAPTER` - OS Service Adapter And Foreground Supervisor
- `SPEC-AGENT-OWNED-GATEWAY-HOST` - Agent-Owned Gateway Host
