import { useAppLocale } from "@/app/copy.ts";
import { useEffect, useRef, useState } from "react";
import { api, apiErrorCode, importSkillZip } from "@/app/api.ts";
import { settingsErrorCopy } from "@/app/settingsErrors";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type {
  CreateSessionResult,
  SkillProjectView,
  SkillSettingsView,
} from "@/app/types.ts";
import {
  NavRow,
  Stack,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/butler-ds";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";
import { SkillActions } from "./SkillActions";
import { SkillGroup } from "./SkillGroup";

export function SkillsSettings() {
  useAppLocale();
  const openSession = useButlerStore((state) => state.openSession);
  const closeSettings = useButlerStore((state) => state.closeSettings);
  const nickname = useSettingsUIStore(
    (state) => state.personalization?.profile.butler_nickname || appCopy.firstRun.product,
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [view, setView] = useState<SkillSettingsView | null>(null);
  const [tab, setTab] = useState("default");
  const [projectId, setProjectId] = useState<string>("");
  const [importProjectId, setImportProjectId] = useState<string | undefined>();
  const [importError, setImportError] = useState<{ code: string; project?: string }>();
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (!projectId && view?.projects[0]) setProjectId(view.projects[0].id);
  }, [view, projectId]);
  async function refresh() {
    setLoadFailed(false);
    try {
      setView(await api<SkillSettingsView>("/skills"));
    } catch {
      setLoadFailed(true);
    }
  }
  async function importSkill(project?: string) {
    setImportError(undefined);
    setImportProjectId(project);
    inputRef.current?.click();
  }
  async function onFile(file: File | undefined) {
    if (!file) return;
    setImportError(undefined);
    try {
      await importSkillZip(file, importProjectId);
      await refresh();
    } catch (error) {
      setImportError({ code: apiErrorCode(error) ?? "unknown", project: importProjectId });
    } finally {
      if (inputRef.current) inputRef.current.value = "";
      setImportProjectId(undefined);
    }
  }
  async function createSkillChat(project?: SkillProjectView) {
    const result = await api<CreateSessionResult>("/sessions", {
      method: "POST",
      body: JSON.stringify({
        kind: project ? "project" : "chat",
        project_id: project?.id,
        title: appCopy.interfaceTemplates.skillTitle(nickname),
        session_hint: `skill-builder-${project?.id ?? "default"}-${Date.now()}`,
      }),
    });
    openSession(result.session.id);
    closeSettings();
  }
  const importMessage = importError ? settingsErrorCopy(importError, appCopy.settings.skillErrors.import) : undefined;
  const selectedProject =
    view?.projects.find((project) => project.id === projectId) ??
    view?.projects[0];
  return (
    <SettingsPage>
      <SettingsSection
        id="skills"
        kind="list"
        state={view === null ? (loadFailed ? "error" : "loading") : "ready"}
        onRetry={() => void refresh()}
      >
      <Stack gap="md">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="default">{appCopy.interfaceDetails.default}</TabsTrigger>
            <TabsTrigger value="project">{appCopy.interfaceDetails.project}</TabsTrigger>
          </TabsList>
          <TabsContent value="default">
            <Stack gap="md">
              <SkillActions
                error={importError && !importError.project ? importMessage : undefined}
                onImport={() => void importSkill()}
                onCreate={() => void createSkillChat()}
              />
              <SkillGroup
                title={appCopy.interfaceDetails.coreSkills}
                skills={view?.core ?? []}
                maxVisibleRows={4}
              />
              <SkillGroup title={appCopy.interfaceDetails.userSkills} skills={view?.user ?? []} />
            </Stack>
          </TabsContent>
          <TabsContent value="project">
            <Stack align="row" gap="md">
              <Stack gap="xs">
                {(view?.projects ?? []).map((project) => (
                  <NavRow
                    key={project.id}
                    label={project.display_name}
                    active={project.id === selectedProject?.id}
                    onClick={() => setProjectId(project.id)}
                  />
                ))}
              </Stack>
              <Stack gap="md" grow basis="0">
                <SkillActions
                  error={importError?.project === selectedProject?.id ? importMessage : undefined}
                  onImport={() => void importSkill(selectedProject?.id)}
                  onCreate={() => void createSkillChat(selectedProject)}
                />
                <SkillGroup
                  title={selectedProject?.display_name ?? appCopy.interfaceDetails.projectSkills}
                  skills={selectedProject?.skills ?? []}
                />
              </Stack>
            </Stack>
          </TabsContent>
        </Tabs>
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(event) => void onFile(event.target.files?.[0])}
        />
      </Stack>
      </SettingsSection>
    </SettingsPage>
  );
}
