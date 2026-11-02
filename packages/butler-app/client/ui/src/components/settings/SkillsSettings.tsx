import { useAppLocale } from "@/app/copy.ts";
import { useEffect, useId, useRef, useState } from "react";
import { api, apiErrorCode, importSkillZip } from "@/app/api.ts";
import { settingsErrorCopy } from "@/app/settingsErrors";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type {
  CreateSessionResult,
  SkillProjectView,
  SkillSettingsView,
} from "@/app/types.ts";
import { FieldError } from "@/butler-ds";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";
import { SkillActions } from "./SkillActions";
import { SkillGroup } from "./SkillGroup";
import { ProjectSkillsSection } from "./ProjectSkillsSection";

export function SkillsSettings() {
  useAppLocale();
  const openSession = useButlerStore((state) => state.openSession);
  const closeSettings = useButlerStore((state) => state.closeSettings);
  const nickname = useSettingsUIStore(
    (state) => state.personalization?.profile.butler_nickname || appCopy.firstRun.product,
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [view, setView] = useState<SkillSettingsView | null>(null);
  const userErrorId = useId();
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
  const userError = importError && !importError.project ? importMessage : undefined;
  const selectedProject =
    view?.projects.find((project) => project.id === projectId) ??
    view?.projects[0];
  const state = view === null ? (loadFailed ? "error" : "loading") : "ready";
  const sections = appCopy.settings.pageSections;
  return (
    <SettingsPage>
      <SettingsSection id="core-skills" kind="list" title={sections.coreSkills}
        state={state === "ready" && !view?.core.length ? "empty" : state}
        emptyMessage={appCopy.interfaceDetails.noSkills} onRetry={() => void refresh()}>
        <SkillGroup skills={view?.core ?? []} maxVisibleRows={4} />
      </SettingsSection>
      <SettingsSection id="user-skills" kind="list" title={sections.userSkills}
        state={state === "ready" && !view?.user.length && !userError ? "empty" : state}
        emptyMessage={appCopy.interfaceDetails.noSkills} onRetry={() => void refresh()}
        actions={<>
          <SkillActions errorId={userError ? userErrorId : undefined}
            onImport={() => void importSkill()} onCreate={() => void createSkillChat()} />
          {/* The one file picker for every skills import; the header is always mounted, whatever the list state. */}
          <input ref={inputRef} type="file" accept=".zip,application/zip" hidden
            onChange={(event) => void onFile(event.target.files?.[0])} />
        </>}>
        {userError ? <FieldError id={userErrorId}>{userError}</FieldError> : null}
        {view?.user.length ? <SkillGroup skills={view.user} /> : null}
      </SettingsSection>
      <ProjectSkillsSection state={state} projects={view?.projects ?? []} project={selectedProject}
        error={importError?.project && importError.project === selectedProject?.id ? importMessage : undefined}
        onProject={setProjectId} onImport={(project) => void importSkill(project.id)}
        onCreate={(project) => void createSkillChat(project)} onRetry={() => void refresh()} />
    </SettingsPage>
  );
}
