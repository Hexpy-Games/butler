import { useEffect } from "react";
import { settingsErrorCopy } from "@/app/settingsErrors";
import type { McpFormErrors } from "./useMcpSettingsActions";
import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { McpTransportKind } from "@/app/types.ts";
import {
  Button,
  ButtonContainer,
  Input,
  NativeSelect,
  NativeSelectOption,
  SettingsField,
  Switch,
} from "@/butler-ds";
import { mcpServerIdError, type McpServerFormState } from "./mcpSettingsUtils";
import { HttpFields } from "./HttpFields";
import { StdioFields } from "./StdioFields";

export function McpServerForm({
  form,
  onChange,
  onCancel,
  onSave,
  busy,
  errors = {},
}: {
  form: McpServerFormState;
  busy: boolean;
  errors?: McpFormErrors;
  onChange: (patch: Partial<McpServerFormState>) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  useAppLocale();
  const copy = appCopy.settings;
  const idProblem = mcpServerIdError(form.id);
  const idError = errors.id ? settingsErrorCopy({ code: errors.id }, copy.mcpIdInvalid)
    : idProblem === "required" ? copy.mcpIdRequired : idProblem ? copy.mcpIdInvalid : undefined;
  useEffect(() => {
    const first = errors.id ? "mcp-server-id" : errors.command ? "mcp-stdio-command" : errors.url ? "mcp-http-url" : null;
    if (first) document.getElementById(first)?.focus();
  }, [errors]);
  return (
    <>
      <SettingsField
        id="mcp-server-id"
        label={copy.fields.mcpServerId}
        description={idError ? undefined : copy.mcpIdPreview(form.id.toLowerCase().replace(/^-+|-+$/gu, ""))}
        descriptionId="mcp-server-id-hint"
        error={idError}
        control={<Input
          id="mcp-server-id"
          required
          value={form.id}
          onChange={(event) => onChange({ id: event.target.value })}
        />}
      />
      <SettingsField
        id="mcp-server-name"
        label={copy.fields.mcpServerName}
        control={<Input
          id="mcp-server-name"
          value={form.displayName}
          onChange={(event) => onChange({ displayName: event.target.value })}
        />}
      />
      <SettingsField
        id="mcp-transport"
        label={copy.fields.mcpTransport}
        control={<NativeSelect
          id="mcp-transport"
          value={form.transport}
          onChange={(event) =>
            onChange({ transport: event.target.value as McpTransportKind })
          }
        >
          <NativeSelectOption value="stdio">
            {copy.options.stdio}
          </NativeSelectOption>
          <NativeSelectOption value="http">
            {copy.options.http}
          </NativeSelectOption>
          <NativeSelectOption value="sse">
            {copy.options.sse}
          </NativeSelectOption>
        </NativeSelect>}
      />
      <SettingsField
        id="mcp-enabled"
        label={copy.fields.enabled}
        control={<Switch
          id="mcp-enabled"
          checked={form.enabled}
          onCheckedChange={(enabled) => onChange({ enabled })}
        />}
      />
      {form.transport === "stdio" ? (
        <StdioFields error={errors.command ? settingsErrorCopy({ code: errors.command }, copy.mcpCommandRequired) : undefined} form={form} onChange={onChange} />
      ) : (
        <HttpFields error={errors.url ? settingsErrorCopy({ code: errors.url }, copy.mcpUrlRequired) : undefined} form={form} onChange={onChange} />
      )}
      <ButtonContainer size="default" justify="end">
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          {appCopy.common.cancel}
        </Button>
        <Button type="button" disabled={busy || Boolean(idError)} onClick={onSave}>
          {appCopy.common.save}
        </Button>
      </ButtonContainer>
    </>
  );
}
