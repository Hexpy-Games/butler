import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { sanitizePublicText } from "../../events/turn-events.ts";
import { evidenceReceipt } from "../executor-support.ts";

type ToolCall = { args: Record<string, unknown> };

export function createDataTableToolHandlers(input: {
  butlerData: string;
}) {
  return {
    "transform_public_data_table": async (call: ToolCall) => transformPublicDataTable({
      butlerData: input.butlerData,
      args: call.args,
    }),
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function publicDataCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "";
  const raw = String(value).trim();
  if (/^(?:\/Users\/|\/var\/|\/tmp\/|[A-Za-z]:\\|\\\\)/u.test(raw)) return "[redacted-path]";
  const text = sanitizePublicText(value, "");
  return text;
}

function csvEscape(value: string): string {
  return /[",\n\r]/u.test(value) ? `"${value.replace(/"/gu, "\"\"")}"` : value;
}

function safeArtifactSlug(value: string): string {
  const slug = value
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9가-힣_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return slug || "public-data-table";
}

export function transformPublicDataTable(input: {
  butlerData: string;
  args: Record<string, unknown>;
}): Record<string, unknown> {
  const columns = stringArray(input.args.columns)
    .map((column) => sanitizePublicText(column, ""))
    .filter(Boolean)
    .slice(0, 12);
  if (columns.length === 0) throw new Error("transform_public_data_table requires at least one column");
  if (!Array.isArray(input.args.rows)) throw new Error("transform_public_data_table requires rows");
  const rows = input.args.rows
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object" && !Array.isArray(row)))
    .slice(0, 50)
    .map((row) => Object.fromEntries(columns.map((column) => [
      column,
      publicDataCell(row[column]),
    ])));
  if (rows.length === 0) throw new Error("transform_public_data_table requires at least one row");
  const title = sanitizePublicText(input.args.title, "public-data-table");
  const artifactId = `public-data-${randomUUID().slice(0, 10)}`;
  const artifactName = `${safeArtifactSlug(title)}-${artifactId}.csv`;
  const artifactDir = join(input.butlerData, "artifacts", "public-data");
  mkdirSync(artifactDir, { recursive: true });
  const csv = [
    columns.map(csvEscape).join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column] ?? "")).join(",")),
  ].join("\n");
  writeFileSync(join(artifactDir, artifactName), `${csv}\n`, "utf8");
  return {
    ok: true,
    durable_artifact_created: true,
    artifact_kind: "csv_file",
    artifact_id: artifactId,
    artifact_label: artifactName,
    artifact_note: "CSV file artifact has been written; use artifact_label as the user-facing file name.",
    title,
    columns,
    row_count: rows.length,
    csv_preview: csv.split("\n").slice(0, 6).join("\n"),
    evidence_receipts: [
      evidenceReceipt({
        producerName: "transform_public_data_table",
        receiptType: "deliverable",
        summary: "A structured public data table artifact was created.",
        covers: ["durable_deliverable", "structured_table"],
        artifacts: [{
          id: artifactId,
          label: artifactName,
          mediaType: "text/csv",
          role: "table",
        }],
        satisfies: ["durable_artifact", "data_table_created"],
        metrics: {
          row_count: rows.length,
          column_count: columns.length,
        },
      }),
    ],
  };
}
