use super::{Item, copy::words};
use crate::ui::{
    browser::{
        engine::TabId,
        model::{BrowserState, Owner},
    },
    composer::state::{ComposerAttachment, ComposerState},
    manage::library::detail::api,
    source::agent::Jobs,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use butler_ds::ui::toast::{self, Toast};
use gpui::{App, ClipboardItem, Window};
use serde_json::{Value, json};

#[derive(Clone, Copy)]
pub(super) enum Action {
    Attach,
    Scrap,
    Save,
    Copy,
}
pub(super) fn command(action: Action, id: &TabId, _: &mut Window, cx: &mut App) {
    let Some(tab) = cx.global::<BrowserState>().tab(id).cloned() else {
        return;
    };
    if tab.selections.is_empty() {
        return;
    }
    match action {
        Action::Copy => {
            cx.write_to_clipboard(ClipboardItem::new_string(
                tab.selections
                    .iter()
                    .map(|p| p.data["text"].as_str().unwrap_or_default())
                    .collect::<Vec<_>>()
                    .join("\n\n"),
            ));
            toast::show(cx, Toast::message(words(cx).copied));
        }
        Action::Attach => attach(&tab.owner, &tab.selections, None, cx),
        Action::Scrap => scrap(id, tab.selections, cx),
        Action::Save => save(tab.selections, cx),
    }
}
pub(super) fn attach(owner: &Owner, items: &[Item], notice: Option<&'static str>, cx: &mut App) {
    let session = match owner {
        Owner::Conversation(id) => Some(id.to_string()),
        Owner::Mine => ComposerState::read(cx, |s| {
            (!s.draft_session_id.starts_with("draft:")).then(|| s.draft_session_id.clone())
        }),
    };
    let Some(session) = session else {
        return;
    };
    let current = ComposerState::read(cx, |s| s.draft_session_id == session);
    if !current {
        return;
    }
    let body = json!({"status":"ok","tab":items.first().map(|item|&item.data["tab"]),"untrusted_content":{"kind":"web_page_data","elements":items.iter().map(|p| p.data.clone()).collect::<Vec<_>>()}});
    ComposerState::update(cx, |state| {
        state.uploading_count += 1;
    });
    cx.refresh_windows();
    let destination = session.clone();
    let upload = Jobs::run(cx, move |client| async move {
        client
            .upload_message_file(
                &destination,
                &butler_shell_client::Upload {
                    file_name: "web-page-data.json".into(),
                    content_type: "application/json".into(),
                    bytes: body.to_string().into_bytes(),
                },
            )
            .await
    });
    cx.spawn(async move |cx| {
        let result = upload.await;
        cx.update(|cx| {
            let file: Option<crate::ui::source::wire::MessageFileRef> = result
                .and_then(Result::ok)
                .and_then(|v| serde_json::from_value(v["file"].clone()).ok());
            let current = ComposerState::read(cx, |state| state.draft_session_id == session);
            if current {
                ComposerState::update(cx, |state| {
                    state.uploading_count = state.uploading_count.saturating_sub(1);
                });
                if let Some(file) = file {
                    ComposerState::update(cx, |state| {
                        state.attachments.push(ComposerAttachment {
                            id: uuid::Uuid::new_v4().to_string(),
                            kind: file.kind.clone(),
                            file,
                        });
                        state.focus_requested = true;
                    });
                    if let Some(notice) = notice {
                        toast::show(cx, Toast::message(notice));
                    }
                } else {
                    toast::show(cx, Toast::error(words(cx).failed));
                }
            }
            cx.refresh_windows();
        });
    })
    .detach();
}
fn scrap(id: &TabId, items: Vec<Item>, cx: &mut App) {
    let id = id.clone();
    cx.spawn(async move |cx| {
        let mut ids = Vec::new();
        for item in items {
            let snapshot = super::snapshot::capture(&id, &item, cx).await.ok();
            let fallback = item.data["id"].as_str().unwrap_or_default().to_owned();
            let reply = cx.update(|cx| {
                let mut body = item.data;
                body["kind"] = json!("scrap");
                if let Some(snapshot) = snapshot {
                    body["snapshot"] = snapshot;
                }
                let (sender, reply) = futures::channel::oneshot::channel();
                api::send(
                    cx,
                    move |client| async move { client.save_library(&body).await },
                    move |result: Result<Value, _>, _| {
                        let _ = sender.send(result);
                    },
                );
                reply
            });
            match reply.await {
                Ok(Ok(value)) => ids.push(value["id"].as_str().unwrap_or(&fallback).to_owned()),
                _ => {
                    cx.update(|cx| toast::show(cx, Toast::error(words(cx).failed)));
                    return;
                }
            }
        }
        cx.update(|cx| crate::ui::manage::library::detail::after_scrap(ids, cx));
    })
    .detach();
}
fn save(items: Vec<Item>, cx: &mut App) {
    let directory = butler_platform::user_dirs::non_empty_home_dir()
        .map_or_else(std::path::PathBuf::new, |home| home.join("Downloads"));
    cx.spawn(async move |cx| {
        let mut saved = 0;
        for (index, item) in items.into_iter().enumerate() {
            let name = format!("selection-{}.jpg", index + 1);
            let ask = cx.update(|cx| cx.prompt_for_new_path(&directory, Some(&name)));
            let Ok(Ok(Some(path))) = ask.await else {
                break;
            };
            let data = item.data["crop"]
                .as_str()
                .and_then(|s| s.strip_prefix("data:image/jpeg;base64,"))
                .and_then(|s| STANDARD.decode(s).ok());
            let Some(data) = data else {
                break;
            };
            let result = cx
                .background_executor()
                .spawn(async move { std::fs::write(path, data) })
                .await;
            if result.is_err() {
                cx.update(|cx| toast::show(cx, Toast::error(words(cx).failed)));
                return;
            }
            saved += 1;
        }
        if saved > 0 {
            cx.update(|cx| toast::show(cx, Toast::message((words(cx).images_saved)(saved))));
        }
    })
    .detach();
}
