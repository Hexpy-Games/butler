import { useEffect } from "react";
import { settingsErrorCopy } from "@/app/settingsErrors";
import type { McpFormErrors } from "./useMcpSettingsActions";
import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { McpTransportKind } from "@/app/types.ts";
import {
  Button,
  ButtonContainer,
  Field,
  FieldLabel,
  FieldError,
  FieldDescription,
  Input,
  NativeSelect,
  NativeSelectOption,
  Stack,
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
    <Stack gap="sm">
      <Field data-invalid={Boolean(idError)}>
        <FieldLabel htmlFor="mcp-server-id">{copy.fields.mcpServerId}</FieldLabel>
        <Input
          id="mcp-server-id"
          required
          aria-invalid={Boolean(idError)}
          aria-describedby="mcp-server-id-hint"
          value={form.id}
          onChange={(event) => onChange({ id: event.target.value })}
        />
        {idError ? <FieldError id="mcp-server-id-hint">
          {idError}
        </FieldError> : <FieldDescription id="mcp-server-id-hint">
          {copy.mcpIdPreview(form.id.toLowerCase().replace(/^-+|-+$/gu, ""))}
        </FieldDescription>}
      </Field>
      <Field>
        <FieldLabel htmlFor="mcp-server-name">{copy.fields.mcpServerName}</FieldLabel>
        <Input
          id="mcp-server-name"
          value={form.displayName}
          onChange={(event) => onChange({ displayName: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="mcp-transport">{copy.fields.mcpTransport}</FieldLabel>
        <NativeSelect
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
        </NativeSelect>
      </Field>
      <Field>
        <FieldLabel htmlFor="mcp-enabled">{copy.fields.enabled}</FieldLabel>
        <Switch
          id="mcp-enabled"
          checked={form.enabled}
          onCheckedChange={(enabled) => onChange({ enabled })}
        />
      </Field>
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
    </Stack>
  );
}
