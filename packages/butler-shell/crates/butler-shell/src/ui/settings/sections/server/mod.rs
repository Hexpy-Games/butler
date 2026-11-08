//! Settings: Server (`ServerSettings.tsx`): the API base URL and the default project folder.
mod copy;

use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::blocks::settings_section::{SettingsPage, SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use gpui::{
    AnyView, App, AppContext as _, Context, IntoElement, ParentElement as _, PathPromptOptions,
    Render, Window,
};
use serde::Deserialize;
use serde_json::json;
use std::path::Path;

use self::copy::words;
use crate::ui::Icon;
use crate::ui::settings::controls::SettingsInput;
use crate::ui::settings::{Save, SectionCtx};
use crate::ui::source::agent::Jobs;

/// The settings fields the page reads (`draft.server_url`, `draft.default_project_workspace_label`).
#[derive(Deserialize)]
struct ServerSlice {
    #[serde(default)]
    server_url: String,
    default_project_workspace_label: Option<String>,
}

pub(crate) fn page(ctx: SectionCtx, window: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| ServerPage::new(ctx, window, cx)).into()
}

struct ServerPage {
    ctx: SectionCtx,
}

impl ServerPage {
    fn new(ctx: SectionCtx, _: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe(&ctx.state, |_, _, cx| cx.notify()).detach();
        Self { ctx }
    }
}

impl ServerPage {
    /// `chooseDefaultProjectFolder`: pick a folder, sign it, save the token.
    fn choose(cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: None,
        });
        cx.spawn(async move |this, cx| {
            let path = picked
                .await
                .ok()
                .and_then(Result::ok)
                .flatten()
                .and_then(|paths| paths.into_iter().next());
            if let Some(path) = path {
                let _ = this.update(cx, |this, cx| this.save_folder(&path, cx));
            }
        })
        .detach();
    }

    fn save_folder(&mut self, path: &Path, cx: &mut Context<Self>) {
        let token = Jobs::client(cx)
            .ok_or(Error::Connection)
            .and_then(|client| client.folder_selection_token(path));
        match token {
            Ok(token) => self.ctx.save(
                json!({ "default_project_folder_selection_token": token }),
                Save::default(),
                cx,
            ),
            Err(_) => {
                let copy = words(Ds::get(cx).lang());
                toast::show(cx, Toast::error(copy.choose_failed));
            }
        }
    }
}

impl Render for ServerPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let slice = self.ctx.state.read(cx).slice::<ServerSlice>();
        let page = SettingsPage::new().labels(SectionCtx::labels(cx));
        // React renders nothing until the settings draft exists.
        let Some(slice) = slice else {
            return page;
        };
        let ctx = self.ctx.clone();
        let connection =
            SettingsSection::new("connection", SettingsSectionKind::Form, copy.connection)
                .holds_fields()
                .child(
                    SettingsInput::new("server-url", copy.server_url, slice.server_url).on_commit(
                        move |value, _, cx| {
                            ctx.save(json!({ "server_url": value.as_ref() }), Save::default(), cx);
                        },
                    ),
                );
        let choose = Button::new("default-project-folder")
            .variant(Variant::Outline)
            .icon_start(icon(Icon::FolderPlus, IconSize::Md, Ds::get(cx)))
            .text(copy.choose_folder)
            .on_click(cx.listener(|_, _, _, cx| Self::choose(cx)));
        let mut folder = SettingsField::new(copy.default_project_folder).control(choose);
        if let Some(label) = slice.default_project_workspace_label {
            folder = folder.description(label);
        }
        let projects = SettingsSection::new("projects", SettingsSectionKind::Form, copy.projects)
            .holds_fields()
            .child(folder);
        page.section(connection).section(projects)
    }
}
