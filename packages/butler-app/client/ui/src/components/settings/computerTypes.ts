export type ComputerModelSource = "follow" | "chatgpt" | "none" | { key: string };
export type MainModelKind = "key" | "chatgpt" | "none";

export interface Computer {
  id: string;
  name: string;
  address: string;
  port: number | null;
  key_file: string | null;
  managed_key?: boolean;
  folder: string;
  os: string;
  arch: string;
  glibc: string | null;
  stops_on_logout: boolean;
  ai_connected: boolean;
  model_source: ComputerModelSource;
  environment: string[];
  environment_text: string;
  added_at: string;
}

export type ComputerConnection = "idle" | "connecting" | "connected" | "reconnecting" | "unreachable";
