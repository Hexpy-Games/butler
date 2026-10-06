import { useId, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { Button, FieldError, IconButton, Input, Plus, SettingsField, Stack, Trash2, Typo } from "@/butler-ds";
import { normalizeAllowedHost } from "./allowedHostName";

/** Extra host names (tunnels, reverse proxies); each change saves the whole list. */
export function SecurityAllowedHostsField({
  hosts,
  disabled,
  onSave,
  content = false,
}: {
  content?: boolean;
  hosts: string[];
  disabled: boolean;
  onSave: (hosts: string[]) => Promise<boolean>;
}) {
  const copy = appCopy.settings.security;
  const inputId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);

  async function add() {
    const host = normalizeAllowedHost(draft);
    if (!host) {
      setInvalid(true);
      return;
    }
    if (hosts.includes(host) || await onSave([...hosts, host])) setDraft("");
  }

  return (
    <SettingsField
      id={inputId}
      settingId={content ? "content-hosts" : "allowed-hosts"}
      label={content ? copy.contentHosts : copy.hosts}
      description={content ? copy.contentHostsDescription : copy.hostsDescription}
      control={(
        <Stack gap="sm">
          {hosts.length > 0 ? (
            <Stack gap="xs">
              {hosts.map((host) => (
                <Stack key={host} align="row" gap="sm" cross="center">
                  <Typo.Code wrap="anywhere">{host}</Typo.Code>
                  <IconButton
                    label={copy.removeHost(host)}
                    disabled={disabled}
                    onClick={() => void onSave(hosts.filter((item) => item !== host))}
                  >
                    <Trash2 size="sm" />
                  </IconButton>
                </Stack>
              ))}
            </Stack>
          ) : (
            <Typo.Caption tone="secondary">{copy.noHosts}</Typo.Caption>
          )}
          <Stack align="row" gap="sm" cross="center">
            <Input
              id={inputId}
              autoComplete="off"
              spellCheck={false}
              placeholder={copy.hostPlaceholder}
              value={draft}
              aria-invalid={invalid ? true : undefined}
              aria-describedby={invalid ? errorId : undefined}
              onChange={(event) => {
                setDraft(event.target.value);
                setInvalid(false);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || disabled || !draft.trim()) return;
                event.preventDefault();
                void add();
              }}
            />
            <Button type="button" size="xs" variant="outline" disabled={disabled || !draft.trim()} onClick={() => void add()}>
              <Plus size="sm" />
              {copy.addHost}
            </Button>
          </Stack>
          {invalid ? <FieldError id={errorId}>{copy.invalidHost}</FieldError> : null}
        </Stack>
      )}
    />
  );
}
