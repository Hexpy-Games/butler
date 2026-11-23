export interface Computer {
  id: string;
  name: string;
  address: string;
  port: number | null;
  key_file: string | null;
  folder: string;
  os: string;
  arch: string;
  glibc: string | null;
  stops_on_logout: boolean;
  ai_connected: boolean;
  added_at: string;
}

export type ComputerConnection = "idle" | "connecting" | "connected" | "reconnecting" | "unreachable";
