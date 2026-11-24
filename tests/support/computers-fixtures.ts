import type { CredentialListView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import type { Computer, ComputerConnection, ComputerModelSource, MainModelKind } from "../../packages/butler-app/client/ui/src/components/settings/computerTypes.ts";

const addedAt = "2026-11-23T00:00:00Z";
const defaults = {
  port: null, key_file: null, folder: "~/projects", os: "linux", arch: "x86_64", glibc: null,
  stops_on_logout: false, ai_connected: true, added_at: addedAt, model_source: "follow" as ComputerModelSource,
};

export const computerFixtures = [
  { ...defaults, id: "10000000-0000-4000-8000-000000000001", name: "Studio iMac", address: "studio" },
  { ...defaults, id: "10000000-0000-4000-8000-000000000002", name: "Living room PC", address: "living-room" },
  { ...defaults, id: "10000000-0000-4000-8000-000000000003", name: "Shared machine", address: "shared", stops_on_logout: true },
] satisfies Computer[];
const addedId = "10000000-0000-4000-8000-000000000004";
const states: Record<string, ComputerConnection> = {
  [computerFixtures[0]!.id]: "connected",
  [computerFixtures[1]!.id]: "unreachable",
};
const credentials: CredentialListView = {
  credentials: [
    { id: "openai", provider_id: "openai", auth_type: "api_key", label: "OpenAI", masked_value: "sk-…test",
      created_at: addedAt, updated_at: addedAt, model_refs: [] },
  ],
  store: { backend: "fallback_file", reason: "config", override_ignored: false, legacy_plaintext: 0 },
};

export const computerAuthUrl = "http://127.0.0.1:9/oauth";
type ComputerCall = { method: string; path: string; body: unknown };
type ComputerStep = "host-key" | "add" | "start" | "edit";

export function computersFocusResponse(path: string): unknown {
  if (path === "/security") {
    return { remote_access_enabled: false, bind_addresses: ["127.0.0.1:18765"], lan_urls: [], allowed_hosts: [], content_hosts: [] };
  }
  if (path === "/computers") return { computers: computerFixtures, main_model: "key" };
  const id = path.match(/^\/computers\/([^/]+)\/connection$/u)?.[1];
  if (id) return { state: states[id] ?? "idle", error: null };
}

export function createComputersFake() {
  const calls: ComputerCall[] = [];
  const failures = new Map<ComputerStep, string>();
  const fake = {
    calls,
    computers: [] as Computer[],
    mainModel: "key" as MainModelKind,
    startHold: undefined as Promise<void> | undefined,
    oauthStatus: "pending",
    oauthCancelStatus: "cancelled",
    failNext(step: ComputerStep, code: string) { failures.set(step, code); },
    respond,
  };
  const ok = (data: unknown, status = 200) => ({ status, json: { protocol_version: "butler.app.v1", data } });
  const error = (code: string) => ({ status: 422, json: { error: { code, message: "TEST" } } });

  async function respond(call: ComputerCall) {
    calls.push(call);
    const { method, path, body } = call;
    const [, id, action] = path.match(/^\/computers\/([^/]+)(?:\/(.*))?$/u) ?? [];
    const step = method === "PUT" && id && !action ? "edit"
      : method !== "POST" ? undefined : path === "/computers/host-key" ? "host-key"
      : path === "/computers" ? "add" : /^\/computers\/[^/]+\/start$/u.test(path) ? "start" : undefined;
    const failure = step && failures.get(step);
    if (step && failure) {
      failures.delete(step);
      return error(failure);
    }
    if (path === "/credentials" && method === "GET") return ok(credentials);
    if (path === "/computers" && method === "GET") return ok({ computers: fake.computers, main_model: fake.mainModel });
    if (step === "host-key") return ok({ trusted: true });
    if (step === "add") {
      const { name, address, port, key_file, folder, model_source } = body as Pick<Computer, "name" | "address" | "port" | "key_file" | "folder" | "model_source">;
      const computer = { ...defaults, id: addedId, name, address, folder, port: port ?? null, key_file: key_file ?? null, ai_connected: false, model_source };
      fake.computers.push(computer);
      return ok({ computer }, 201);
    }
    const computer = fake.computers.find((entry) => entry.id === id);
    if (!computer) return error("computer_not_found");
    if (step === "edit") {
      const { name, address, port, key_file, folder, model_source } = body as Pick<Computer, "name" | "address" | "port" | "key_file" | "folder" | "model_source">;
      const edited = {
        ...computer, name, address, folder, port: port ?? null, key_file: key_file ?? null, model_source,
        ai_connected: model_source !== "none" && model_source !== "chatgpt",
      };
      fake.computers = fake.computers.map((entry) => entry.id === id ? edited : entry);
      return ok({ computer: edited });
    }
    if (method === "DELETE" && !action) {
      fake.computers = fake.computers.filter((entry) => entry.id !== id);
      return ok({ deleted: true, remote_cleaned: true });
    }
    if (step === "start") {
      await fake.startHold;
      computer.ai_connected = computer.model_source !== "none" && computer.model_source !== "chatgpt";
      return ok({ state: "ready", version: "1.0.0" });
    }
    if (action === "connection" && method === "GET") return ok({ state: states[computer.id] ?? "idle", error: null });
    if (method === "PATCH" && !action) {
      computer.model_source = (body as Pick<Computer, "model_source">).model_source;
      computer.ai_connected = computer.model_source !== "none" && computer.model_source !== "chatgpt";
      return ok({ computer });
    }
    if (action === "oauth/start" && method === "POST") {
      return ok({ status: "pending", flow_id: "flow_1", auth_url: computerAuthUrl });
    }
    if ((action === "oauth/flow_1" && method === "GET") || (action === "oauth/flow_1/cancel" && method === "POST")) {
      const status = method === "GET" ? fake.oauthStatus : fake.oauthCancelStatus;
      if (status === "completed") {
        computer.ai_connected = true;
        computer.model_source = "chatgpt";
      }
      return ok({ status });
    }
    throw new Error(`Unexpected computer request: ${method} ${path}`);
  }
  return fake;
}
