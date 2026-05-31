import { useEffect, useMemo, useState } from "react";
import type { McpSecretSource } from "@/app/types.ts";
import {
  Button,
  ButtonContainer,
  IconButton,
  Input,
  NativeSelect,
  NativeSelectOption,
  Plus,
  SettingsSecretRow,
  SettingsSecretRows,
  Trash2,
} from "@/butler-ds";
import { emptySecretRow, type McpSecretRowState } from "./mcpSettingsUtils";
import { mcpSecretValuePlaceholder } from "./mcpSecretRowsUtils";

const SOURCE_OPTIONS: Array<{ value: McpSecretSource; label: string }> = [
  { value: "literal", label: "직접값" },
  { value: "env", label: "ENV 참조" },
  { value: "file", label: "파일" },
];

export function McpSecretRows({
  title,
  addLabel,
  rows,
  onRowsChange,
}: {
  title: string;
  addLabel: string;
  rows: McpSecretRowState[];
  onRowsChange: (rows: McpSecretRowState[]) => void;
}) {
  const commonSource = useMemo(() => {
    if (rows.length === 0) return null;
    const firstSource = rows[0]?.source;
    return firstSource && rows.every((row) => row.source === firstSource)
      ? firstSource
      : null;
  }, [rows]);
  const [selectedSource, setSelectedSource] = useState<McpSecretSource>(
    commonSource ?? "literal",
  );

  useEffect(() => {
    if (commonSource) setSelectedSource(commonSource);
  }, [commonSource]);

  function updateRow(id: string, patch: Partial<McpSecretRowState>) {
    onRowsChange(
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  }
  const deleteRow = (id: string) =>
    onRowsChange(rows.filter((row) => row.id !== id));
  const addRow = () => onRowsChange([...rows, emptySecretRow(selectedSource)]);
  const applySourceToAll = () =>
    onRowsChange(rows.map((row) => ({ ...row, source: selectedSource })));

  return (
    <SettingsSecretRows
      title={title}
      emptyState={rows.length === 0 ? "추가된 항목이 없습니다." : undefined}
      actions={
        <>
          <NativeSelect
            aria-label={`${title} 기본 출처`}
            size="sm"
            value={selectedSource}
            onChange={(event) =>
              setSelectedSource(event.target.value as McpSecretSource)
            }
          >
            {SOURCE_OPTIONS.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <ButtonContainer size="xs">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={
                rows.length === 0 ||
                rows.every((row) => row.source === selectedSource)
              }
              onClick={applySourceToAll}
            >
              전체 출처 적용
            </Button>
            <Button type="button" size="xs" variant="outline" onClick={addRow}>
              <Plus size={13} />
              {addLabel}
            </Button>
          </ButtonContainer>
        </>
      }
    >
      {rows.map((row) => (
        <SettingsSecretRow
          key={row.id}
          sourceControl={
            <NativeSelect
              aria-label={`${title} 값 출처`}
              value={row.source}
              onChange={(event) =>
                updateRow(row.id, {
                  source: event.target.value as McpSecretSource,
                })
              }
            >
              {SOURCE_OPTIONS.map((option) => (
                <NativeSelectOption key={option.value} value={option.value}>
                  {option.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          }
          keyControl={
            <Input
              aria-label={`${title} key`}
              placeholder="KEY"
              value={row.key}
              onChange={(event) =>
                updateRow(row.id, { key: event.target.value })
              }
            />
          }
          valueControl={
            <Input
              aria-label={`${title} value`}
              placeholder={mcpSecretValuePlaceholder(row)}
              value={row.value}
              onChange={(event) =>
                updateRow(row.id, { value: event.target.value })
              }
            />
          }
          actionControl={
            <IconButton
              label={`${title} 행 삭제`}
              onClick={() => deleteRow(row.id)}
            >
              <Trash2 size={14} />
            </IconButton>
          }
        />
      ))}
    </SettingsSecretRows>
  );
}
