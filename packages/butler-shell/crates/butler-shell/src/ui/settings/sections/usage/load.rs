//! The page's reads: `useUsageRange` (UsageSettings.tsx), `useUsageHistory` and `useImageUsage`.
//! A read that was started before the page asked again is dropped, as React's `cancelled` does.
use std::collections::HashMap;

use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use serde_json::{Value, json};

use super::copy::words;
use super::wire::{History, ImageUsage, View};
use super::{UsagePage, view_key};
use crate::ui::settings::state::fetch;
use gpui::Context;

/// The image usage range that also decides whether the section shows.
pub(super) const VISIBILITY_DAYS: u32 = 30;

/// What `useImageUsage` keeps: one revision's reads.
pub(super) struct Snapshot {
    pub(super) revision: u32,
    pub(super) selected: bool,
    pub(super) ranges: HashMap<u32, ImageUsage>,
}

impl UsagePage {
    /// `rememberView`: one scoped view and the all-chat view per range are kept.
    fn remember_view(&mut self, key: String, view: View) {
        let all = format!("{}/", key.split('/').next().unwrap_or_default());
        if key != all {
            self.views
                .retain(|stored, _| !stored.starts_with(&all) || *stored == all);
        }
        self.views.insert(key, view);
    }

    /// The effect of `useUsageRange`: the chat's view, and the all-chat view once per revision.
    pub(super) fn load_range(&mut self, cx: &mut Context<Self>) {
        let (hours, revision) = (self.hours, self.revision);
        let key = view_key(hours, self.session.as_deref());
        self.generation += 1;
        let generation = self.generation;
        self.pending = Some(key.clone());
        self.error = None;
        let needs_all = self.all_revisions.get(&hours) != Some(&revision);
        let mut requests: Vec<Option<String>> = Vec::new();
        if self.session.is_some() && needs_all {
            requests.push(None);
        }
        if self.session.is_some() || needs_all {
            requests.push(self.session.clone());
        }
        self.outstanding = requests.len();
        if requests.is_empty() {
            self.pending = None;
        }
        for session in requests {
            let request_key = view_key(hours, session.as_deref());
            let page_key = key.clone();
            let for_call = session.clone();
            fetch(
                cx,
                move |client| async move {
                    client
                        .get_usage_monitor(for_call.as_deref(), Some(f64::from(hours)))
                        .await
                },
                move |this: &mut Self, result: Result<Value, Error>, _| {
                    if generation != this.generation {
                        return;
                    }
                    match result.ok().as_ref().and_then(View::decode) {
                        Some(view) => {
                            if session.is_none() {
                                this.all_revisions.insert(hours, revision);
                            }
                            this.remember_view(request_key, view);
                            this.outstanding = this.outstanding.saturating_sub(1);
                            if this.outstanding == 0 {
                                this.pending = None;
                            }
                        }
                        None => {
                            this.error = Some(page_key);
                            this.pending = None;
                        }
                    }
                },
            );
        }
    }

    /// `useUsageHistory`: a failure shows the `usage-history` toast.
    pub(super) fn load_history(&mut self, cx: &mut Context<Self>) {
        self.history_generation += 1;
        let generation = self.history_generation;
        fetch(
            cx,
            |client| async move { client.get_usage_history().await },
            move |this: &mut Self, result: Result<History, Error>, cx| {
                if generation != this.history_generation {
                    return;
                }
                match result {
                    Ok(history) => this.history = Some(history),
                    Err(_) => {
                        let copy = words(Ds::get(cx).lang());
                        let toast = Toast::error(copy.usage_failed);
                        let toast = match this.toast {
                            Some(id) => toast.id(id),
                            None => toast,
                        };
                        this.toast = Some(toast::show(cx, toast));
                    }
                }
            },
        );
    }

    /// The effect of `useImageUsage`: the image model setting and the ranges, once per revision.
    pub(super) fn load_images(&mut self, cx: &mut Context<Self>) {
        let (days, revision) = (self.image_days, self.revision);
        if self.images.as_ref().is_some_and(|snapshot| {
            snapshot.revision == revision && snapshot.ranges.contains_key(&days)
        }) {
            return;
        }
        self.image_error = false;
        self.image_generation += 1;
        let generation = self.image_generation;
        let mut wanted = vec![VISIBILITY_DAYS];
        if days != VISIBILITY_DAYS {
            wanted.push(days);
        }
        fetch(
            cx,
            move |client| async move {
                let setting = client.get_image_model_settings().await?;
                let mut ranges = Vec::new();
                for range in wanted {
                    ranges.push(client.get_image_usage(range).await?);
                }
                Ok::<_, Error>(json!({
                    "selected": setting.get("selected").cloned().unwrap_or(Value::Null),
                    "ranges": ranges,
                }))
            },
            move |this: &mut Self, result: Result<Value, Error>, _| {
                if generation != this.image_generation {
                    return;
                }
                match result.ok().and_then(|raw| decode_snapshot(&raw, revision)) {
                    Some(snapshot) => this.images = Some(snapshot),
                    None => this.image_error = true,
                }
            },
        );
    }
}

fn decode_snapshot(raw: &Value, revision: u32) -> Option<Snapshot> {
    let ranges: Vec<ImageUsage> = serde_json::from_value(raw.get("ranges")?.clone()).ok()?;
    Some(Snapshot {
        revision,
        selected: raw.get("selected").is_some_and(|value| !value.is_null()),
        ranges: ranges.into_iter().map(|view| (view.days, view)).collect(),
    })
}
