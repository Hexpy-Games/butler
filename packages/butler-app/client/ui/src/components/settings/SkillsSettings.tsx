import { useEffect, useRef, useState } from "react";
import { api, importSkillZip } from "@/app/api.ts";
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
import { SettingsSection } from "./SettingsFormComponents";
import { SkillActions } from "./SkillActions";
import { SkillGroup } from "./SkillGroup";

export function SkillsSettings() {
  const copy = appCopy.settings;
  const openSession = useButlerStore((state) => state.openSession);
  const closeSettings = useButlerStore((state) => state.closeSettings);
  const nickname = useSettingsUIStore(
    (state) => state.personalization?.profile.butler_nickname || "Butler",
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [view, setView] = useState<SkillSettingsView | null>(null);
  const [tab, setTab] = useState("default");
  const [projectId, setProjectId] = useState<string>("");
  const [importProjectId, setImportProjectId] = useState<string | undefined>();
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (!projectId && view?.projects[0]) setProjectId(view.projects[0].id);
  }, [view, projectId]);
  async function refresh() {
    setView(await api<SkillSettingsView>("/skills"));
  }
  async function importSkill(project?: string) {
    setImportProjectId(project);
    inputRef.current?.click();
  }
  async function onFile(file: File | undefined) {
    if (!file) return;
    await importSkillZip(file, importProjectId);
    setImportProjectId(undefined);
    await refresh();
  }
  async function createSkillChat(project?: SkillProjectView) {
    const result = await api<CreateSessionResult>("/sessions", {
      method: "POST",
      body: JSON.stringify({
        kind: project ? "project" : "chat",
        project_id: project?.id,
        title: `${nickname}과 어떤 스킬을 만들어볼까요?`,
        session_hint: `skill-builder-${project?.id ?? "default"}-${Date.now()}`,
      }),
    });
    openSession(result.session.id);
    closeSettings();
  }
  const selectedProject =
    view?.projects.find((project) => project.id === projectId) ??
    view?.projects[0];
  return (
    <SettingsSection
      title={copy.panels.skills}
      description={copy.descriptions.skills}
    >
      <Stack gap="md">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="default">기본</TabsTrigger>
            <TabsTrigger value="project">프로젝트</TabsTrigger>
          </TabsList>
          <TabsContent value="default">
            <Stack gap="md">
              <SkillActions
                onImport={() => void importSkill()}
                onCreate={() => void createSkillChat()}
              />
              <SkillGroup
                title="코어 기본 스킬"
                skills={view?.core ?? []}
                maxVisibleRows={4}
              />
              <SkillGroup title="사용자 추가 스킬" skills={view?.user ?? []} />
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
              <Stack gap="md" style={{ flex: 1 }}>
                <SkillActions
                  onImport={() => void importSkill(selectedProject?.id)}
                  onCreate={() => void createSkillChat(selectedProject)}
                />
                <SkillGroup
                  title={selectedProject?.display_name ?? "프로젝트 스킬"}
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
  );
}
