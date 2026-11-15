//! Fresh output capabilities and file frame sources (`useOutputView`, `HtmlFileFrame`).
use super::{Mode, SessionArtifactSummary};
use crate::ui::{
    browser::{self, embed::EmbeddedPage, model::BrowserState},
    i18n::{artifact_viewer::ArtifactViewerCopy, browser::BrowserStrings},
    source::agent::Jobs,
    widgets::anchor,
};
use butler_ds::ui::{
    button::{Button, Size, Variant},
    layout::{Space, Stack},
    native_select::NativeSelect,
    tooltip::Tooltip,
    typo::Typo,
};
use gpui::{
    AnyElement, App, Context, Entity, IntoElement as _, ParentElement as _, SharedString, Window,
    div,
};
use serde::Deserialize;
use std::time::Duration;

#[derive(Clone, Deserialize)]
struct View {
    url: String,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    revisions: Vec<u64>,
    expires_at: Option<u64>,
}

struct Source {
    view: Option<View>,
    failed: bool,
    content_host_required: bool,
    task: Option<gpui::Task<()>>,
    generation: u64,
}

impl Source {
    fn load(
        &mut self,
        artifact: SessionArtifactSummary,
        mode: Mode,
        revision: Option<u64>,
        cx: &mut Context<Self>,
    ) {
        self.failed = false;
        self.task = Some(cx.spawn(async move |weak, cx| {
            loop {
                let artifact = artifact.clone();
                let request = cx.update(|cx| {
                    Jobs::run(cx, move |client| async move {
                        resolve(&client, &artifact, mode, revision).await
                    })
                });
                let result = request
                    .await
                    .unwrap_or(Err(butler_shell_client::Error::Connection));
                let content_host_required =
                    matches!(result, Err(butler_shell_client::Error::ContentHostRequired));
                let view = result.ok();
                let refresh = view
                    .as_ref()
                    .and_then(|v| v.expires_at)
                    .map(|expiry| Duration::from_secs(expiry.saturating_sub(now() + 60).max(1)));
                if weak
                    .update(cx, |this, cx| {
                        this.failed = view.is_none();
                        if view.is_some() {
                            this.generation += 1;
                        }
                        this.content_host_required = content_host_required;
                        if mode != Mode::Html || view.is_some() {
                            this.view = view;
                        }
                        cx.notify();
                    })
                    .is_err()
                {
                    return;
                }
                cx.update(App::refresh_windows);
                let Some(delay) = refresh else {
                    return;
                };
                butler_ds::ui::motion::sleep(cx.background_executor(), delay).await;
            }
        }));
    }
}

fn now() -> u64 {
    u64::try_from(chrono::Utc::now().timestamp()).unwrap_or_default()
}

async fn pdf_source(
    client: &butler_shell_client::ShellClient,
    artifact: &SessionArtifactSummary,
) -> Option<View> {
    let mut source = artifact
        .signed_url
        .as_deref()
        .or(artifact.url.as_deref())?
        .to_owned();
    let mut url = client.file_url(&source).ok()?;
    let expiry = |url: &url::Url| {
        url.query_pairs()
            .find(|(key, _)| key == "expires")
            .and_then(|(_, v)| v.parse::<u64>().ok())
    };
    if expiry(&url).is_none_or(|at| at <= now()) {
        let raw = client
            .list_artifacts(artifact.session_id.as_deref()?)
            .await
            .ok()?;
        let items = raw.as_array().or_else(|| raw["artifacts"].as_array())?;
        source = items
            .iter()
            .flat_map(|item| {
                std::iter::once(item).chain(
                    item["revisions"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|revision| revision.get("file")),
                )
            })
            .find(|item| item["file_id"].as_str() == artifact.file_id.as_deref())?["signed_url"]
            .as_str()?
            .to_owned();
        url = client.file_url(&source).ok()?;
    }
    if expiry(&url).is_none_or(|at| at <= now()) {
        return None;
    }
    Some(View {
        url: url.to_string(),
        revision: 0,
        revisions: Vec::new(),
        expires_at: expiry(&url),
    })
}

pub(super) fn preview(
    artifact: &SessionArtifactSummary,
    mode: Mode,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let key = SharedString::from(format!(
        "artifact-source:{}:{:?}:{}",
        artifact.id,
        mode,
        artifact.file_id.as_deref().unwrap_or_default()
    ));
    let state = window.use_keyed_state(key, cx, |_, cx| {
        let mut state = Source {
            view: None,
            failed: false,
            content_host_required: false,
            task: None,
            generation: 0,
        };
        state.load(artifact.clone(), mode, None, cx);
        state
    });
    let copy = ArtifactViewerCopy::get(cx);
    let view = state.read(cx).view.clone();
    let body = if let Some(view) = &view {
        EmbeddedPage::frame(
            &format!("{}:{}", artifact.id, state.read(cx).generation),
            &view.url,
            window,
            cx,
        )
        .into_any_element()
    } else {
        Typo::caption(if state.read(cx).content_host_required {
            copy.content_host_required
        } else if state.read(cx).failed {
            copy.load_failed
        } else {
            copy.loading
        })
        .into_any_element()
    };
    let mut stack = Stack::new().gap(Space::Sm);
    if mode == Mode::Web {
        stack = stack.child(controls(artifact, &state, view.as_ref(), cx));
    }
    stack.child(body).into_any_element()
}

fn controls(
    artifact: &SessionArtifactSummary,
    state: &Entity<Source>,
    view: Option<&View>,
    cx: &App,
) -> AnyElement {
    let copy = ArtifactViewerCopy::get(cx);
    let enabled = cx.global::<BrowserState>().enabled();
    let mut buttons = butler_ds::ui::button::container(Size::Xs);
    let url = view.map(|v| v.url.clone());
    let open = Button::new("output-open")
        .size(Size::Xs)
        .variant(Variant::Outline)
        .text(copy.open)
        .on_click(move |_, _, cx| {
            if let Some(url) = &url {
                browser::open_link(url, cx);
            }
        });
    buttons = buttons.child(if view.is_some() {
        open
    } else {
        open.disabled()
    });
    let (session, url) = (artifact.session_id.clone(), view.map(|v| v.url.clone()));
    let preview = artifact
        .url
        .as_deref()
        .filter(|url| url.starts_with("/previews/"))
        .map(|_| artifact.id.clone());
    let browser = Button::new("output-browser")
        .size(Size::Xs)
        .variant(Variant::Outline)
        .text(copy.open_browser)
        .on_click(move |_, _, cx| {
            if let Some(url) = &url {
                browser::open_output_in_browser(session.as_deref(), url, preview.as_deref(), cx);
            }
        });
    buttons = if enabled && view.is_some() {
        buttons.child(anchor(div(), "output-browser").child(browser))
    } else {
        buttons.child(
            Tooltip::new("output-browser-disabled")
                .label(BrowserStrings::get(cx).update_required)
                .child(browser.disabled()),
        )
    };
    let (reload, artifact_reload) = (state.clone(), artifact.clone());
    buttons = buttons.child(
        anchor(div(), "output-reload").child(
            Button::new("output-reload")
                .size(Size::Xs)
                .variant(Variant::Outline)
                .text(BrowserStrings::get(cx).reload)
                .on_click(move |_, _, cx| {
                    reload.update(cx, |s, cx| {
                        let revision = s.view.as_ref().map(|v| v.revision);
                        s.load(artifact_reload.clone(), Mode::Web, revision, cx);
                    });
                }),
        ),
    );
    let row = Stack::row().gap(Space::Sm).wrap(true).child(buttons);
    revisions(row, artifact, state, view, copy)
}

async fn resolve(
    client: &butler_shell_client::ShellClient,
    artifact: &SessionArtifactSummary,
    mode: Mode,
    revision: Option<u64>,
) -> Result<View, butler_shell_client::Error> {
    let raw = match mode {
        Mode::Web
            if artifact
                .url
                .as_deref()
                .is_some_and(|u| u.starts_with("/previews/")) =>
        {
            client.get_preview_view(&artifact.id).await
        }
        Mode::Web => client.get_output_view(&artifact.id, revision).await,
        Mode::Html => {
            client
                .get_message_file_view(
                    artifact
                        .file_id
                        .as_deref()
                        .ok_or(butler_shell_client::Error::Protocol)?,
                )
                .await
        }
        _ => {
            return pdf_source(client, artifact)
                .await
                .ok_or(butler_shell_client::Error::Protocol);
        }
    }?;
    let view: View =
        serde_json::from_value(raw).map_err(|_| butler_shell_client::Error::Protocol)?;
    let url = url::Url::parse(&view.url).map_err(|_| butler_shell_client::Error::Protocol)?;
    if !matches!(url.scheme(), "http" | "https") || client.is_api_origin(&url) {
        return Err(butler_shell_client::Error::Protocol);
    }
    if mode == Mode::Html && view.expires_at.is_none_or(|expiry| expiry <= now()) {
        return Err(butler_shell_client::Error::Protocol);
    }
    Ok(view)
}

fn revisions(
    mut row: Stack,
    artifact: &SessionArtifactSummary,
    state: &Entity<Source>,
    view: Option<&View>,
    copy: &ArtifactViewerCopy,
) -> AnyElement {
    if let Some(view) = view.filter(|_| {
        !artifact
            .url
            .as_deref()
            .is_some_and(|u| u.starts_with("/previews/"))
    }) {
        let (state, artifact) = (state.clone(), artifact.clone());
        let mut select = NativeSelect::new("output-revision")
            .value(view.revision.to_string())
            .on_change(move |value, _, cx| {
                if let Ok(revision) = value.parse() {
                    state.update(cx, |s, cx| {
                        s.load(artifact.clone(), Mode::Web, Some(revision), cx);
                    });
                }
            });
        for revision in &view.revisions {
            select = select.option(
                revision.to_string(),
                format!("{} {revision}", copy.revision),
            );
        }
        row = row.child(select);
    }
    row.into_any_element()
}
