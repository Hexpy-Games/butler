//! `ComposerContextControl`, `ContextUsagePopover`, `conversationUsage`, `useConversationUsage`.
//!
//! The composer's context donut. Hover previews the context and usage popover; a click pins it
//! open until a second click, Esc or an outside click. Details opens Settings > Usage.
//!
//! The control owns no network: while the popover is open it asks for the chat's usage through
//! [`ComposerContextEvent::LoadUsage`] and [`ComposerContextEvent::LoadQuota`], and the owner
//! runs [`load_usage`] / [`load_quota`] and hands the results to `usage_loaded` /
//! `quota_loaded`.
#![allow(
    dead_code,
    unused_imports,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
mod copy;
mod popover;
mod timeline;
mod usage;

use std::collections::HashMap;
use std::rc::Rc;

use butler_ds::ui::blocks::context_donut_button::ContextDonutButton;
use butler_ds::ui::blocks::usage_bars::Emphasis;
use butler_ds::ui::context::Ds;
use butler_ds::ui::overlay::place::Side;
use butler_ds::ui::popover::{Popover, PopoverContent, Width};
use gpui::{
    App, ClickEvent, Context, EventEmitter, InteractiveElement as _, IntoElement as _,
    ParentElement as _, Render, StatefulInteractiveElement as _, Window, div,
};

use self::popover::{Props, usage_popover};
use self::usage::ConversationUsage;
pub(crate) use self::usage::{
    ProviderQuota, UsageAuthMode, UsageModel, UsageMonitorView, UsageStatus, context_model,
    usage_auth_mode,
};
pub(crate) use self::usage::{load_quota, load_usage};
use crate::ui::source::wire::ContextDetailsView;

/// What the control asks of its owner.
pub(crate) enum ComposerContextEvent {
    /// The popover opened (or the context changed while open): load this session's usage
    /// monitor view, then call `usage_loaded` with the same `session_id` and `revision`.
    LoadUsage {
        session_id: String,
        revision: String,
    },
    /// Load the provider's stored quota, then call `quota_loaded`.
    LoadQuota { provider_id: String },
    /// The popover opened or closed (`setContextPopoverOpen`).
    OpenChanged(bool),
    /// Details: open Settings > Usage.
    OpenUsageSettings,
}

pub(crate) struct ComposerContextControl {
    context: Option<ContextDetailsView>,
    models: Vec<UsageModel>,
    active_model: Option<UsageModel>,
    active_chat_id: Option<String>,
    open: bool,
    pinned: bool,
    selected: Option<usize>,
    emphasis: Option<Emphasis>,
    /// Last view per session, so reopening shows it at once while it refreshes.
    views: HashMap<String, UsageMonitorView>,
    /// Last quota per provider, shown before the monitor answers.
    quotas: HashMap<String, ProviderQuota>,
    /// The key of the last finished usage load and how it ended.
    result: Option<(String, UsageStatus)>,
    requested_usage: Option<String>,
    requested_quota: Option<String>,
}

impl EventEmitter<ComposerContextEvent> for ComposerContextControl {}

/// `contextRevision`: the session view's context, which changes when the context does.
fn context_revision(context: &ContextDetailsView) -> String {
    context
        .updated_at
        .clone()
        .unwrap_or_else(|| format!("{}/{}", context.used_tokens, context.budget_tokens))
}

fn usage_key(session_id: &str, revision: &str) -> String {
    format!("{session_id}\u{0}{revision}")
}

impl ComposerContextControl {
    pub(crate) fn new() -> Self {
        Self {
            context: None,
            models: Vec::new(),
            active_model: None,
            active_chat_id: None,
            open: false,
            pinned: false,
            selected: None,
            emphasis: None,
            views: HashMap::new(),
            quotas: HashMap::new(),
            result: None,
            requested_usage: None,
            requested_quota: None,
        }
    }

    /// `resetConversationUsageCache`.
    pub(crate) fn reset_usage_cache(&mut self) {
        self.views.clear();
        self.quotas.clear();
    }

    /// The composer store's `context`, `models` and `activeModel`, and the active chat id.
    pub(crate) fn set_input(
        &mut self,
        context: Option<ContextDetailsView>,
        models: Vec<UsageModel>,
        active_model: Option<UsageModel>,
        active_chat_id: Option<String>,
        cx: &mut Context<Self>,
    ) {
        self.context = context;
        self.models = models;
        self.active_model = active_model;
        self.active_chat_id = active_chat_id;
        self.sync_loads(cx);
        cx.notify();
    }

    /// `contextPopoverOpen`.
    pub(crate) fn is_open(&self) -> bool {
        self.open
    }

    pub(crate) fn set_open(&mut self, open: bool, cx: &mut Context<Self>) {
        if self.open != open {
            self.open = open;
            cx.emit(ComposerContextEvent::OpenChanged(open));
        }
        self.sync_loads(cx);
        cx.notify();
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        self.selected = None;
        self.pinned = false;
        self.set_open(false, cx);
    }

    /// A click pins the popover, or unpins and closes it.
    fn toggle_pin(&mut self, cx: &mut Context<Self>) {
        if self.pinned {
            self.close(cx);
            return;
        }
        self.pinned = true;
        self.set_open(true, cx);
    }

    fn hover(&mut self, hovered: bool, cx: &mut Context<Self>) {
        if hovered {
            self.set_open(true, cx);
        } else if !self.pinned {
            self.set_open(false, cx);
        }
    }

    /// The `useConversationUsage` effects: fetch when the popover opens and again when the
    /// context's revision changes while open; nothing polls.
    fn sync_loads(&mut self, cx: &mut Context<Self>) {
        let Some(context) = self.context.as_ref().filter(|_| self.open) else {
            self.requested_usage = None;
            self.requested_quota = None;
            return;
        };
        let mode = usage_auth_mode(
            context_model(&self.models, context, self.active_model.as_ref()),
            context,
        );
        let session = context
            .session_id
            .clone()
            .or_else(|| self.active_chat_id.clone())
            .filter(|_| mode.tracked());
        let Some(session_id) = session else {
            return;
        };
        let revision = context_revision(context);
        let key = usage_key(&session_id, &revision);
        let provider = (mode == UsageAuthMode::Subscription)
            .then(|| context.provider_id.clone())
            .flatten();
        if self.requested_usage.as_ref() != Some(&key) {
            self.requested_usage = Some(key);
            // TODO(integration: run on agent worker): `load_usage(client, &session_id)`.
            cx.emit(ComposerContextEvent::LoadUsage {
                session_id,
                revision: revision.clone(),
            });
        }
        if let Some(provider_id) = provider {
            let quota_key = usage_key(&provider_id, &revision);
            if self.requested_quota.as_ref() != Some(&quota_key) {
                self.requested_quota = Some(quota_key);
                // TODO(integration: run on agent worker): `load_quota(client, &provider_id)`.
                cx.emit(ComposerContextEvent::LoadQuota { provider_id });
            }
        }
    }

    /// The answer to `LoadUsage`: `None` when the call failed.
    pub(crate) fn usage_loaded(
        &mut self,
        session_id: &str,
        revision: &str,
        view: Option<UsageMonitorView>,
        cx: &mut Context<Self>,
    ) {
        let status = if let Some(view) = view {
            self.views.insert(session_id.to_owned(), view);
            UsageStatus::Ready
        } else {
            UsageStatus::Failed
        };
        self.result = Some((usage_key(session_id, revision), status));
        cx.notify();
    }

    /// The answer to `LoadQuota`; a failed call leaves what was shown.
    pub(crate) fn quota_loaded(
        &mut self,
        provider_id: &str,
        quota: Option<ProviderQuota>,
        cx: &mut Context<Self>,
    ) {
        if let Some(quota) = quota {
            self.quotas.insert(provider_id.to_owned(), quota);
        }
        cx.notify();
    }

    fn conversation_usage(
        &self,
        context: &ContextDetailsView,
        mode: UsageAuthMode,
    ) -> ConversationUsage<'_> {
        let session = context
            .session_id
            .as_ref()
            .or(self.active_chat_id.as_ref())
            .filter(|_| mode.tracked());
        let provider = (mode == UsageAuthMode::Subscription)
            .then_some(context.provider_id.as_ref())
            .flatten();
        let status = session.map_or(UsageStatus::Idle, |session| {
            let key = usage_key(session, &context_revision(context));
            match &self.result {
                Some((done, status)) if *done == key => *status,
                _ if self.open => UsageStatus::Loading,
                _ => UsageStatus::Idle,
            }
        });
        ConversationUsage {
            view: session.and_then(|s| self.views.get(s)),
            quota: provider.and_then(|p| self.quotas.get(p)),
            status,
        }
    }
}

impl Render for ComposerContextControl {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl gpui::IntoElement {
        let Some(context) = self.context.clone() else {
            return div().into_any_element();
        };
        let lang = Ds::get(cx).lang();
        let this = cx.entity();
        let mode = usage_auth_mode(
            context_model(&self.models, &context, self.active_model.as_ref()),
            &context,
        );
        let popover = {
            let this = this.clone();
            Popover::new("composer-context", window, cx)
                .open(self.open)
                .on_open_change(move |next, _, cx| {
                    this.update(cx, |control, cx| {
                        if next {
                            control.set_open(true, cx);
                        } else {
                            control.close(cx);
                        }
                    });
                })
        };
        let open = self.open;
        #[expect(
            clippy::cast_possible_truncation,
            reason = "a context ratio between 0 and 1"
        )]
        let ratio = context.ratio as f32;
        let trigger = {
            let (click, hover) = (this.clone(), this.clone());
            popover.trigger(move |_| {
                let donut = ContextDonutButton::new("context-donut", ratio)
                    .expanded(open)
                    .on_click(move |_, _, cx| click.update(cx, |c, cx| c.toggle_pin(cx)));
                div()
                    .id("context-donut-hover")
                    .on_hover(move |hovered, _, cx| {
                        hover.update(cx, |c, cx| c.hover(*hovered, cx));
                    })
                    .child(donut)
                    .into_any_element()
            })
        };
        let body = usage_popover(
            &Props {
                context: &context,
                mode,
                usage: self.conversation_usage(&context, mode),
                selected: self.selected,
                emphasis: self.emphasis,
                lang,
                on_select: {
                    let this = this.clone();
                    Rc::new(move |index: Option<usize>, _: &mut Window, cx: &mut App| {
                        this.update(cx, |c, cx| {
                            c.selected = index;
                            cx.notify();
                        })
                    })
                },
                on_emphasis: {
                    let this = this.clone();
                    Rc::new(
                        move |emphasis: Option<Emphasis>, _: &mut Window, cx: &mut App| {
                            this.update(cx, |c, cx| {
                                c.emphasis = emphasis;
                                cx.notify();
                            })
                        },
                    )
                },
                on_details: Rc::new(move |_: &ClickEvent, _: &mut Window, cx: &mut App| {
                    this.update(cx, |c, cx| {
                        c.close(cx);
                        cx.emit(ComposerContextEvent::OpenUsageSettings);
                    })
                }),
            },
            cx,
        );
        let content = popover.content(
            PopoverContent::new()
                .side(Side::Top)
                .side_offset(10.)
                .width(Width::Narrow)
                .child(body),
            window,
            cx,
        );
        div().child(trigger).child(content).into_any_element()
    }
}
