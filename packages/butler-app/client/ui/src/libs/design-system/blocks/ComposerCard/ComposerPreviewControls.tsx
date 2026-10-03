import type { AdaptiveShellTheme } from "../../lib/theme";
import { useState } from "react";
import { IconButton } from "../../components/IconButton";
import { AiChip, Plus, ShieldQuestion } from "../../components/Icons";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/Popover";
import { NativeSelect } from "../../components/NativeSelect";
import { Switch } from "../../components/Switch";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ComposerControl } from "../ComposerControl";
import { ComposerCardToolbar, ComposerSendButton } from "./index";

function Picker({ label, value, values, onChange, theme, model = false }: {
  label: string; value: string; values: string[]; onChange: (value: string) => void; model?: boolean; theme: AdaptiveShellTheme;
}) {
  return <Popover><PopoverTrigger asChild>
    <ComposerControl aria-label={`${label}: ${value}`} label={value} compact={model ? "label" : "icon"}
      icon={model ? <AiChip size="sm" /> : <ShieldQuestion size="sm" />} />
  </PopoverTrigger><PopoverContent theme={theme} side="top" width="narrow">
    <NativeSelect aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
      {values.map(item => <option key={item}>{item}</option>)}
    </NativeSelect>
  </PopoverContent></Popover>;
}

export function ComposerPreviewControls({ streaming, canSend, blocked, onStop, onAttach, dark }: {
  dark: boolean; streaming: boolean; canSend: boolean; blocked: boolean; onStop: () => void; onAttach: () => void;
}) {
  const theme: AdaptiveShellTheme = { appearance: dark ? "dark" : "light" };
  const [model, setModel] = useState("Luna");
  const [access, setAccess] = useState("Ask");
  const [workspace, setWorkspace] = useState("Local");
  const [plan, setPlan] = useState(false);
  return <ComposerCardToolbar theme={theme} leading={<>
    <IconButton label="Attach" onClick={onAttach}><Plus size="sm" /></IconButton>
    <Picker theme={theme} label="Access" value={access} values={["Ask", "Read", "Full"]} onChange={setAccess} />
  </>} secondary={<>
    <NativeSelect aria-label="Workspace" value={workspace} onChange={event => setWorkspace(event.target.value)}>
      <option>Local</option><option>Worktree</option>
    </NativeSelect>
    <Stack align="row" cross="center" gap="xs"><Switch aria-label="Plan" checked={plan} onCheckedChange={setPlan} /><Typo.Caption>Plan</Typo.Caption></Stack>
    <Popover><PopoverTrigger asChild><ComposerControl aria-label="Context" label="42%" /></PopoverTrigger>
      <PopoverContent theme={theme} side="top" width="narrow"><Typo.Body>42% · 84,000 / 200,000 tokens</Typo.Body></PopoverContent>
    </Popover>
  </>} trailing={<ComposerSendButton aria-label={streaming ? "Stop" : "Send"} mode={streaming ? "stop" : "send"}
    disabled={!streaming && (!canSend || blocked)} title={blocked ? "Answer above or write a message" : undefined} onClick={streaming ? onStop : undefined} />}>
    <Picker theme={theme} label="Model" value={model} values={["Luna", "Sol", "Astra"]} onChange={setModel} model />
  </ComposerCardToolbar>;
}
