import { useEffect, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import {
  Button, ButtonContainer, CardList, FieldError, Plus, SettingsField, Stack, Tabs, TabsContent, TabsList,
  TabsTrigger, Typo, WallpaperPicker,
} from "@/butler-ds";
import type { McpServerView } from "@/app/types";
import { McpServerRow } from "@/components/settings/McpServerRow";
import { useWallpaperAssets } from "@/components/settings/hooks/useWallpaperAssets";
import { wallpaperPickerLabels } from "@/components/settings/wallpaperPickerLabels";
import { useSettingsUIStore } from "@/stores/settingsUIStore";
import { emptyMcpServerForm, type McpServerFormState } from "@/components/settings/mcpSettingsUtils";
import { SecurityAllowedHostsField } from "@/components/settings/SecurityAllowedHostsField";
import { SettingsPage, SettingsSection } from "@/components/settings/SettingsFormComponents";
import { SkillActions } from "@/components/settings/SkillActions";
import { SkillGroup } from "@/components/settings/SkillGroup";
import { ERROR_COPY, t } from "../proposedCopy";
import type { McpFieldError, StageState } from "../state";
import { McpFormProposal, type McpFormErrors } from "./McpFormProposal";

const SKILLS = [
  { name: "release-notes", description: "Draft release notes from merged PRs.", source: "user", file_path: "", user_invocable: true },
] as const;

const MCP_SERVER: McpServerView = {
  id: "linear", display_name: "Linear", enabled: true, transport: "http", url: "https://mcp.linear.app/sse",
  args: [], env: [], headers: [], created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
};

function mcpErrors(locale: StageState["locale"], error: McpFieldError): McpFormErrors {
  const copy = appCopy.settings;
  if (error === "idRequired") return { id: copy.mcpIdRequired };
  if (error === "idInvalid") return { id: copy.mcpIdInvalid };
  if (error === "commandRequired") return { command: copy.mcpCommandRequired };
  if (error === "urlRequired") return { url: copy.mcpUrlRequired };
  void locale;
  return {};
}

function McpScreen({ state }: { state: StageState }) {
  const [form, setForm] = useState<McpServerFormState>(emptyMcpServerForm());
  useEffect(() => {
    setForm({
      ...emptyMcpServerForm(),
      id: state.mcpError === "idRequired" ? "" : state.mcpError === "idInvalid" ? "깃허브" : "github",
      displayName: "GitHub",
      transport: state.mcpError === "urlRequired" ? "http" : "stdio",
      command: state.mcpError === "commandRequired" ? "" : "npx",
    });
  }, [state.mcpError]);
  const save = () => {
    if (state.mcpError === "saveFailed") notifyStatus(t(state.locale, "settings.mcpErrors.save"), { id: "mcp-save", tone: "error" });
  };
  return (
    <>
      {/* As McpSettings on main: the server list section, then the open form section. */}
      <SettingsSection id="mcp-servers" kind="list" actions={(
        <Button type="button" size="sm"><Plus size="md" /> {appCopy.settings.actions.addMcpServer}</Button>
      )}>
        <CardList empty={<Typo.Caption>{appCopy.interfaceDetails.noMcp}</Typo.Caption>}>
          <McpServerRow server={MCP_SERVER} busy={false} onProbe={() => undefined} onToggle={() => undefined}
            onEdit={() => undefined} onRemove={() => undefined} />
        </CardList>
      </SettingsSection>
      <SettingsSection id="mcp-server-form" kind="form" title={appCopy.settings.actions.addMcpServer}>
        <McpFormProposal form={form} errors={mcpErrors(state.locale, state.mcpError)}
          onChange={(patch) => setForm((current) => ({ ...current, ...patch }))} onSave={save} />
      </SettingsSection>
    </>
  );
}

function SkillsScreen({ state }: { state: StageState }) {
  return (
    <SettingsSection id="skills" kind="list">
      <Stack gap="md">
        <Tabs value="default">
          <TabsList>
            <TabsTrigger value="default">{appCopy.interfaceDetails.default}</TabsTrigger>
            <TabsTrigger value="project">{appCopy.interfaceDetails.project}</TabsTrigger>
          </TabsList>
          <TabsContent value="default">
            <Stack gap="md">
              {/* NEW: the import result sits under the import actions it belongs to. */}
              <Stack gap="xs">
                <SkillActions onImport={() => undefined} onCreate={() => undefined} />
                <FieldError>{t(state.locale, "settings.skillErrors.invalid")}</FieldError>
              </Stack>
              <SkillGroup title={appCopy.interfaceDetails.userSkills} skills={[...SKILLS]} />
            </Stack>
          </TabsContent>
        </Tabs>
      </Stack>
    </SettingsSection>
  );
}

function WallpaperScreen({ state }: { state: StageState }) {
  const appLocale = useAppLocale();
  const copy = appCopy.settings;
  const draft = useSettingsUIStore((store) => store.draft);
  const images = useWallpaperAssets();
  if (!draft) return null;
  return (
    <SettingsSection id="home-screen" kind="form" title={copy.pageSections.homeScreen} description={copy.pageSectionDescriptions.homeScreen}>
      <SettingsField settingId="main-screen-wallpaper" label={copy.fields.wallpaper} description={copy.descriptions.wallpaper}
        control={(
          <Stack gap="sm">
            <WallpaperPicker dataTestClass="settings-main-screen-wallpaper-picker" images={images.assets} importingModule={false}
              labels={wallpaperPickerLabels()} locale={appLocale} uploading={false} value={draft.wallpaper.source}
              onChange={() => undefined} onDeleteImage={() => undefined} onDeleteModule={() => undefined}
              onImportModule={() => undefined} onUpload={() => undefined} />
            {/* NEW: replaces the toast that showed the gateway's first message line. */}
            <FieldError>{t(state.locale, "settings.wallpaper.moduleInvalid")}</FieldError>
          </Stack>
        )} />
    </SettingsSection>
  );
}

function ToastScreen({ state }: { state: StageState }) {
  const toasts = ERROR_COPY.filter((entry) => entry.surface === "toast");
  return (
    <SettingsSection id="toasts" kind="form">
      <Stack gap="sm">
        <Typo.Caption tone="secondary">{state.locale === "ko-KR" ? "누르면 실제 토스트로 보여 줍니다." : "Tap to show the real toast."}</Typo.Caption>
        <ButtonContainer size="sm" wrap>
          {toasts.map((entry) => (
            <Button key={entry.key} type="button" size="sm" variant="outline"
              onClick={() => notifyStatus(t(state.locale, entry.key), { id: "proposal-toast", tone: "error" })}>
              {t(state.locale, entry.key)}
            </Button>
          ))}
        </ButtonContainer>
      </Stack>
    </SettingsSection>
  );
}

export function ErrorsProposal({ state }: { state: StageState }) {
  useAppLocale();
  return (
    <SettingsPage>
      {state.errorScreen === "mcp" ? <McpScreen state={state} /> : null}
      {state.errorScreen === "skills" ? <SkillsScreen state={state} /> : null}
      {state.errorScreen === "wallpaper" ? <WallpaperScreen state={state} /> : null}
      {state.errorScreen === "hosts" ? (
        <SettingsSection id="allowed-hosts" kind="form" title={appCopy.settings.pageSections.allowedHosts}>
          {/* Real product field, unchanged: the pattern the others follow. Type "a b" and Add. */}
          <SecurityAllowedHostsField hosts={["butler.example.ts.net"]} disabled={false} onSave={async () => true} />
        </SettingsSection>
      ) : null}
      {state.errorScreen === "toasts" ? <ToastScreen state={state} /> : null}
    </SettingsPage>
  );
}
