import { appCopy } from "@/app/copy.ts";
import type { HostTarget } from "./computersApi";

export type ComputerField = "name" | "address" | "port" | "keyFile" | "folder";
export interface ComputerFieldError { field: ComputerField; message: string }
export interface ComputerForm { name: string; address: string; port: string; keyFile: string; folder: string }

export const COMPUTER_FIELD_IDS: Record<ComputerField, string> = {
  name: "computer-name",
  address: "computer-address",
  port: "computer-port",
  keyFile: "computer-key-file",
  folder: "computer-folder",
};

export function addFailure(code: string | undefined): ComputerFieldError | null {
  const copy = appCopy.computers.errors;
  const fields = new Map<string, ComputerFieldError>([
    ["ssh_auth_failed", { field: "address", message: copy.keyLogin }],
    ["ssh_unreachable", { field: "address", message: copy.unreachable }],
    ["ssh_client_missing", { field: "address", message: copy.unreachable }],
    ["host_key_changed", { field: "address", message: copy.fingerprintChanged }],
    ["host_key_unconfirmed", { field: "address", message: copy.fingerprintChanged }],
    ["unsupported_computer", { field: "address", message: copy.unsupported }],
    ["computer_address_invalid", { field: "address", message: copy.addressInvalid }],
    ["computer_name_taken", { field: "name", message: copy.nameTaken }],
    ["computer_name_required", { field: "name", message: copy.nameInvalid }],
    ["computer_name_invalid", { field: "name", message: copy.nameInvalid }],
    ["computer_port_invalid", { field: "port", message: copy.portInvalid }],
    ["computer_key_file_invalid", { field: "keyFile", message: copy.keyFileInvalid }],
    ["computer_folder_missing", { field: "folder", message: copy.folderMissing }],
    ["computer_folder_required", { field: "folder", message: copy.folderInvalid }],
    ["project_folder_unsafe", { field: "folder", message: copy.homeFolder }],
  ]);
  return code === undefined ? null : fields.get(code) ?? null;
}

export function validateComputerForm(form: ComputerForm): ComputerFieldError | null {
  const port = form.port.trim();
  if (port && (!/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    return { field: "port", message: appCopy.computers.errors.portInvalid };
  }
  const folder = form.folder.trim();
  if (folder === "~" || folder === "~/") return { field: "folder", message: appCopy.computers.errors.homeFolder };
  return null;
}

export function hostTarget(form: ComputerForm): HostTarget {
  return {
    address: form.address.trim(),
    port: form.port.trim() ? Number(form.port.trim()) : undefined,
    key_file: form.keyFile.trim() || undefined,
  };
}
