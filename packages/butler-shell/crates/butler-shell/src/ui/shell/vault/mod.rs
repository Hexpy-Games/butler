//! Shared vault controller, mirroring Electron `useButlerVault.ts`.
pub(crate) mod copy;
mod prompt;
mod section;
pub(crate) use prompt::Prompt;

use crate::ui::settings::{
    SectionCtx,
    confirm::{Detail, Request},
    state::fetch,
};
use butler_ds::ui::context::Lang;
use butler_shell_client::Error;
use gpui::{App, Context, Entity};
use serde::Deserialize;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum State {
    Loading,
    Ready,
    Unsupported,
    Error,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Protection {
    Protected,
    Off,
    Locked,
}

#[derive(Deserialize)]
pub(crate) struct View {
    pub(crate) state: Protection,
    pub(crate) available: bool,
    pub(crate) declined: bool,
    pub(crate) counts: Option<Counts>,
}

#[derive(Deserialize)]
pub(crate) struct Counts {
    api_key: u64,
    signin: u64,
    card: u64,
    profile: u64,
    plugin: u64,
}

impl Counts {
    pub(crate) fn kinds(&self, lang: Lang) -> String {
        [
            self.api_key,
            self.signin,
            self.card,
            self.profile,
            self.plugin,
        ]
        .into_iter()
        .zip(copy::words(lang).kinds)
        .filter(|(count, _)| *count != 0)
        .map(|(count, name)| format!("{name} {count}"))
        .collect::<Vec<_>>()
        .join(" · ")
    }
}

pub(crate) struct Vault {
    pub(crate) state: State,
    pub(crate) view: Option<View>,
    pub(crate) busy: bool,
}

impl Vault {
    pub(crate) fn new(cx: &mut Context<Self>) -> Self {
        fetch(
            cx,
            |client| async move { client.butler_vault().await },
            |this: &mut Self, result: Result<View, Error>, _| match result {
                Ok(view) => {
                    this.view = Some(view);
                    this.state = State::Ready;
                }
                Err(Error::Http(404) | Error::Incompatible) => this.state = State::Unsupported,
                Err(_) => this.state = State::Error,
            },
        );
        Self {
            state: State::Loading,
            view: None,
            busy: false,
        }
    }

    pub(crate) fn offered(&self) -> bool {
        self.state == State::Ready
            && self.view.as_ref().is_some_and(|view| {
                view.available && matches!(view.state, Protection::Off) && !view.declined
            })
    }

    pub(crate) fn enable(
        &mut self,
        done: impl FnOnce(bool, &mut App) + 'static,
        cx: &mut Context<Self>,
    ) {
        if self.busy {
            return;
        }
        self.busy = true;
        cx.notify();
        fetch(
            cx,
            |client| async move { client.enable_butler_vault().await },
            move |this: &mut Self, result: Result<View, Error>, cx| {
                this.busy = false;
                let ok = result.is_ok();
                if let Ok(view) = result {
                    this.view = Some(view);
                }
                done(ok, cx);
            },
        );
    }

    /// Electron `useButlerVault.ts`: cancellation never sends the decline POST.
    pub(crate) fn decline(
        entity: &Entity<Self>,
        host: &SectionCtx,
        lang: Lang,
        done: impl FnOnce(bool, &mut App) + 'static,
        cx: &mut App,
    ) {
        if entity.read(cx).busy {
            return;
        }
        let copy = copy::words(lang);
        let mut request = Request::new(copy.decline_note)
            .title(copy.decline_title)
            .confirm_label(copy.decline_confirm);
        for text in copy.risks {
            request = request.detail(Detail {
                label: None,
                text: text.into(),
                caption: None,
            });
        }
        let entity = entity.clone();
        host.confirm(
            request,
            move |_, cx| {
                entity.update(cx, |this, cx| {
                    if this.busy {
                        return;
                    }
                    this.busy = true;
                    cx.notify();
                    fetch(
                        cx,
                        |client| async move { client.decline_butler_vault().await },
                        move |this: &mut Self, result: Result<View, Error>, cx| {
                            this.busy = false;
                            let declined = result.as_ref().is_ok_and(|view| view.declined);
                            if let Ok(view) = result {
                                this.view = Some(view);
                            }
                            done(declined, cx);
                        },
                    );
                });
            },
            cx,
        );
    }
}
