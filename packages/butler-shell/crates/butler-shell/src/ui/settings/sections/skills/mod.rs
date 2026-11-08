//! Settings: Skills (`SkillsSettings.tsx`). Built-in, user and project skills; import a skill
//! `.zip`, or start a chat that builds one.
//!
//! Not ported: React maps the import error code to a message (`skillErrors.invalid`/`tooLarge`);
//! the client returns no code, so every failed import shows `skillErrors.import`.
mod copy;
mod group;
mod project;
mod types;

use std::path::Path;

use butler_ds::ui::blocks::settings_section::{
    SettingsPage, SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::context::Ds;
use butler_ds::ui::field::FieldError;
use butler_shell_client::{Error, Upload};
use gpui::{
    AnyView, App, AppContext as _, Context, IntoElement, ParentElement as _, PathPromptOptions,
    Render, Styled as _, Window, div,
};
use serde::Deserialize;
use serde_json::{Value, json};

use self::copy::{SkillsCopy, words};
use self::group::{skill_actions, skill_group};
use self::types::{SkillProject, SkillSettings};
use crate::ui::settings::SectionCtx;
use crate::ui::settings::state::fetch;

/// A failed import: the project it was for, none for the user's own skills.
struct ImportFailure {
    project: Option<String>,
}

pub(crate) struct SkillsPage {
    ctx: SectionCtx,
    view: Option<SkillSettings>,
    load_failed: bool,
    project_id: Option<String>,
    import_error: Option<ImportFailure>,
}

pub(crate) fn page(ctx: SectionCtx, window: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| SkillsPage::new(ctx, window, cx)).into()
}

/// `POST /sessions`: only the new session's id is read.
#[derive(Deserialize)]
struct Created {
    session: CreatedSession,
}

#[derive(Deserialize)]
struct CreatedSession {
    id: String,
}

impl SkillsPage {
    fn new(ctx: SectionCtx, _: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe(&ctx.state, |_, _, cx| cx.notify()).detach();
        let mut page = Self {
            ctx,
            view: None,
            load_failed: false,
            project_id: None,
            import_error: None,
        };
        page.refresh(cx);
        page
    }

    fn copy(cx: &App) -> &'static SkillsCopy {
        words(Ds::get(cx).lang())
    }

    /// `selectedProject`: the picked project, else the first.
    fn selected_project(&self) -> Option<&SkillProject> {
        let projects = &self.view.as_ref()?.projects;
        projects
            .iter()
            .find(|project| Some(&project.id) == self.project_id.as_ref())
            .or_else(|| projects.first())
    }

    /// Whether the last import failed for `project` (none: the user's own skills).
    fn import_failure(&self, project: Option<&String>) -> bool {
        self.import_error
            .as_ref()
            .is_some_and(|error| error.project.as_ref() == project)
    }

    /// `refresh`
    fn refresh(&mut self, cx: &mut Context<Self>) {
        self.load_failed = false;
        fetch(
            cx,
            |client| async move { client.list_skills().await },
            |this: &mut Self, result: Result<SkillSettings, Error>, _| match result {
                Ok(view) => this.view = Some(view),
                Err(_) => this.load_failed = true,
            },
        );
    }

    /// `importSkill`: pick a `.zip`, then upload it to the user's skills or to `project`.
    fn import_skill(&mut self, project: Option<String>, cx: &mut Context<Self>) {
        self.import_error = None;
        cx.notify();
        let chosen = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: None,
        });
        cx.spawn(async move |this, cx| {
            let path = chosen
                .await
                .ok()
                .and_then(Result::ok)
                .flatten()
                .and_then(|paths| paths.into_iter().next());
            let Some(path) = path else {
                return;
            };
            let read = cx
                .background_executor()
                .spawn({
                    let path = path.clone();
                    async move { std::fs::read(path) }
                })
                .await;
            let _ = this.update(cx, |this, cx| match read {
                Ok(bytes) => Self::upload(&path, bytes, project, cx),
                Err(_) => this.import_error = Some(ImportFailure { project }),
            });
        })
        .detach();
    }

    /// `importSkillZip`, then `refresh`.
    fn upload(path: &Path, bytes: Vec<u8>, project: Option<String>, cx: &mut Context<Self>) {
        let file = Upload {
            file_name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            content_type: "application/zip".into(),
            bytes,
        };
        let target = project.clone();
        fetch(
            cx,
            move |client| async move { client.import_skill(target.as_deref(), &file).await },
            move |this: &mut Self, result: Result<Value, Error>, cx| match result {
                Ok(_) => this.refresh(cx),
                Err(_) => this.import_error = Some(ImportFailure { project }),
            },
        );
    }

    /// `createSkillChat`: a new chat (in the project, when given) titled for building a skill,
    /// then open it and close the settings.
    fn create_chat(project: Option<String>, cx: &mut Context<Self>) {
        let copy = Self::copy(cx);
        let hint = format!(
            "skill-builder-{}-{}",
            project.as_deref().unwrap_or("default"),
            chrono::Utc::now().timestamp_millis()
        );
        fetch(
            cx,
            move |client| async move {
                let nickname = client
                    .get_personalization()
                    .await
                    .ok()
                    .and_then(|value| {
                        value
                            .pointer("/profile/butler_nickname")
                            .and_then(Value::as_str)
                            .filter(|name| !name.is_empty())
                            .map(str::to_owned)
                    })
                    .unwrap_or_else(|| copy.product.to_owned());
                let mut body = json!({
                    "kind": if project.is_some() { "project" } else { "chat" },
                    "title": (copy.skill_title)(&nickname),
                    "session_hint": hint,
                });
                if let (Some(project), Some(body)) = (project, body.as_object_mut()) {
                    body.insert("project_id".into(), project.into());
                }
                client.create_session_with(&body).await
            },
            |this: &mut Self, result: Result<Created, Error>, cx| {
                if let Ok(created) = result {
                    this.ctx.open_session(created.session.id.into(), cx);
                }
            },
        );
    }
}

impl Render for SkillsPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = Self::copy(cx);
        let state = match (&self.view, self.load_failed) {
            (Some(_), _) => SettingsSectionState::Ready,
            (None, true) => SettingsSectionState::Error,
            (None, false) => SettingsSectionState::Loading,
        };
        let ready = state == SettingsSectionState::Ready;
        let empty_or = |empty: bool| {
            if ready && empty {
                SettingsSectionState::Empty
            } else {
                state
            }
        };
        let (core, user) = match &self.view {
            Some(view) => (view.core.as_slice(), view.user.as_slice()),
            None => (&[][..], &[][..]),
        };
        let user_error = self.import_failure(None);
        let core_section =
            SettingsSection::new("core-skills", SettingsSectionKind::List, copy.core_skills)
                .state(empty_or(core.is_empty()))
                .empty_message(copy.no_skills)
                .on_retry(cx.listener(|page, _, _, cx| page.refresh(cx)))
                .child(skill_group("core-skills-list", core, Some(4), cx));
        let mut user_section =
            SettingsSection::new("user-skills", SettingsSectionKind::List, copy.user_skills)
                .state(empty_or(user.is_empty() && !user_error))
                .empty_message(copy.no_skills)
                .on_retry(cx.listener(|page, _, _, cx| page.refresh(cx)))
                .actions(skill_actions(
                    "user-skills",
                    copy,
                    cx.listener(|page, _, _, cx| page.import_skill(None, cx)),
                    cx.listener(|_, _, _, cx| Self::create_chat(None, cx)),
                ));
        if user_error {
            user_section = user_section.child(FieldError::new().errors([copy.import_failed]));
        }
        if !user.is_empty() {
            user_section = user_section.child(skill_group("user-skills-list", user, None, cx));
        }
        let project_section = self.project_section(state, copy, window, cx);
        div().w_full().child(
            SettingsPage::new()
                .labels(SectionCtx::labels(cx))
                .section(core_section)
                .section(user_section)
                .section(project_section),
        )
    }
}
