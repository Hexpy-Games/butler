import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconButton } from "../../components/IconButton";
import { Plus, Trash2 } from "../../components/Icons";
import { Input } from "../../components/Input";
import { NativeSelect, NativeSelectOption } from "../../components/NativeSelect";
import { SettingsSecretRow, SettingsSecretRows } from "./SettingsSecretRows";

export const meta: ShowcaseMeta = {
  title: "SettingsSecretRows",
  category: "Settings & Forms",
  tags: ["settings", "mcp", "secrets", "env", "headers"],
  status: "stable",
};

const labels = {
  "en-US": { headers: "Headers", env: "Environment", literal: "Literal value", envVar: "Environment variable", keychain: "Keychain",
    source: "Value source", defaultSource: "Default source", apply: "Apply to all", add: "Add header", addEnv: "Add variable", remove: "Delete row", empty: "No entries yet." },
  "ko-KR": { headers: "헤더", env: "환경", literal: "직접 입력", envVar: "환경 변수", keychain: "키체인",
    source: "값 출처", defaultSource: "기본 출처", apply: "모두에 적용", add: "헤더 추가", addEnv: "변수 추가", remove: "행 삭제", empty: "아직 항목이 없습니다." },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

function SourceSelect({ context, label, size }: { context: ShowcaseRenderContext; label: string; size?: "sm" }) {
  const copy = text(context);
  return (
    <NativeSelect aria-label={label} defaultValue="env" size={size}>
      <NativeSelectOption value="literal">{copy.literal}</NativeSelectOption>
      <NativeSelectOption value="env">{copy.envVar}</NativeSelectOption>
      <NativeSelectOption value="keychain">{copy.keychain}</NativeSelectOption>
    </NativeSelect>
  );
}

/** McpSecretRows: default-source toolbar, then one row per secret. */
function Rows({ context, title, add, rows }: { context: ShowcaseRenderContext; title: string; add: string; rows: Array<[string, string]> }) {
  const copy = text(context);
  return (
    <SettingsSecretRows title={title} emptyState={rows.length === 0 ? copy.empty : undefined} actions={(
      <>
        <SourceSelect context={context} label={`${copy.defaultSource}: ${title}`} size="sm" />
        <ButtonContainer size="xs">
          <Button type="button" size="xs" variant="outline" disabled={rows.length === 0} text={copy.apply} />
          <Button type="button" size="xs" variant="outline"><Plus size="sm" />{add}</Button>
        </ButtonContainer>
      </>
    )}>
      {rows.map(([key, value]) => (
        <SettingsSecretRow key={key}
          sourceControl={<SourceSelect context={context} label={`${copy.source}: ${title}`} />}
          keyControl={<Input aria-label={`${title} key`} placeholder="KEY" defaultValue={key} />}
          valueControl={<Input aria-label={`${title} value`} placeholder="GITHUB_TOKEN" defaultValue={value} />}
          actionControl={<IconButton label={copy.remove}><Trash2 size="sm" /></IconButton>} />
      ))}
    </SettingsSecretRows>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "HTTP headers",
    widths: ["375", "app", "wide"],
    render: (context) => <Rows context={context} title={text(context).headers} add={text(context).add} rows={[["Authorization", "BUTLER_GITHUB_TOKEN"], ["X-Org", "butler"]]} />,
  },
  { name: "Empty environment", render: (context) => <Rows context={context} title={text(context).env} add={text(context).addEnv} rows={[]} /> },
];
