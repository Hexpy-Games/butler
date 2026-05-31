# Butler Agent App Gateway

The app gateway is a Bun-native local HTTP boundary for the dedicated Butler
client. Butler Agent owns this gateway runtime. It owns the app-facing SQLite
projection, accepts user messages, and durably enqueues them as app transport
events for `butler-main`.

Run the server:

```bash
bun run app:server
```

## Scripts

- `bun run app:server` - Run the agent-owned app gateway (local HTTP only)
- `bun run app:web` - Build UI and run the app gateway for local browser access
- `butler gateway run app` - Run the app gateway through the Butler CLI
- `butler gateway configure app --host HOST --port PORT` - Configure the
  canonical app gateway host/port while no settings UI is available

## Environment Variables

**Server Configuration:**

- `BUTLER_APP_SERVER_PORT`: local HTTP port, default `18765`.
- `BUTLER_APP_SERVER_HOST`: server hostname, default `127.0.0.1`.
- `BUTLER_APP_SERVER_DB`: SQLite path for app chat state.
- `BUTLER_APP_DEV_ORIGIN`: optional local HTTP origin for Vite/Electron
  development. The default app gateway already allows `http://127.0.0.1:5173`.
- `BUTLER_APP_SERVER_BRIDGE=off`: keep the app server in external bridge mode
  for explicit tests. Normal app messages without an injected test responder
  are queued through the app transport instead of being answered by the gateway
  store directly.
- `BUTLER_PROJECT_FOLDER_TOKEN_SECRET`: optional override for desktop folder
  selection token signing. When omitted, Electron uses an in-process local
  secret for the current desktop run.

## Related Specs

- `SPEC-BUTLER-DEDICATED-CLIENT` - Butler Dedicated Client
- `SPEC-BUTLER-DEDICATED-CLIENT-APP-EXPERIENCE` - Butler Dedicated Client App Experience
- `SPEC-BUTLER-DEDICATED-CLIENT-PROTOCOL` - Butler Dedicated Client App Protocol
- `SPEC-TRANSPORT-EXPANSION-READINESS` - Transport Expansion Readiness
