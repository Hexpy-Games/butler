//! Settings: Hooks (`HooksSettings.tsx`, `HookRow.tsx`). The list of hooks, the add/edit dialog
//! ([`form`]) and the recent runs ([`runs`]). The hooks routes are admin calls.
//! React reads `/hooks` only on open and after its own actions, so there is no event bus to
//! skip.
mod copy;
mod form;
mod runs;
mod types;

use std::rc::Rc;

use butler_ds::ui::blocks::card_list::{CardList, CardListItem};
use butler_ds::ui::blocks::settings_section::{
    SettingsPage, SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::button::{self, Button, Size as ButtonSize, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dialog::{Dialog, DialogContent};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::switch::Switch;
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::tooltip::Tooltip;
use butler_ds::ui::typo::Typo;
use butler_shell_client::Error;
use gpui::{
    AnyElement, AnyView, App, AppContext as _, Context, IntoElement, ParentElement as _, Render,
    SharedString, Styled as _, Window, div, prelude::FluentBuilder as _,
};
use serde::Deserialize;
use serde_json::json;

use self::copy::{HooksCopy, words};
use self::form::Form;
use self::runs::{OnToggle, runs_list};
use self::types::{HookDefinition, HookRun, HookSettings};
use crate::ui::Icon;
use crate::ui::i18n::settings::{Words, words as frame_words};
use crate::ui::settings::SectionCtx;
use crate::ui::settings::confirm::Request;
use crate::ui::settings::state::fetch;

/// `/hooks` and `/hooks/runs`, read together.
#[derive(Deserialize)]
struct Loaded {
    settings: HookSettings,
    runs: Vec<HookRun>,
}

pub(crate) struct HooksPage {
    ctx: SectionCtx,
    settings: Option<HookSettings>,
    runs: Vec<HookRun>,
    editing: Option<Form>,
    busy: bool,
    failed: bool,
    expanded: Option<usize>,
}

pub(crate) fn page(ctx: SectionCtx, window: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| HooksPage::new(ctx, window, cx)).into()
}

/// A tooltip around `child` when there is a label.
fn tip(
    id: impl Into<SharedString>,
    label: Option<SharedString>,
    child: impl IntoElement,
) -> AnyElement {
    let id: SharedString = id.into();
    match label {
        Some(label) => Tooltip::new(id)
            .label(label)
            .child(child)
            .into_any_element(),
        None => child.into_any_element(),
    }
}

impl HooksPage {
    fn new(ctx: SectionCtx, _: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe(&ctx.state, |_, _, cx| cx.notify()).detach();
        let page = Self {
            ctx,
            settings: None,
            runs: Vec::new(),
            editing: None,
            busy: false,
            failed: false,
            expanded: None,
        };
        Self::refresh(cx);
        page
    }

    fn hooks(&self) -> &[HookDefinition] {
        self.settings
            .as_ref()
            .map_or(&[][..], |settings| settings.config.hooks.as_slice())
    }

    fn copy(cx: &App) -> &'static HooksCopy {
        words(Ds::get(cx).lang())
    }

    /// `refresh`
    fn refresh(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move {
                let settings = client.get_hooks().await?;
                let runs = client.get_hook_runs().await?;
                Ok::<_, Error>(json!({ "settings": settings, "runs": runs }))
            },
            |this: &mut Self, result: Result<Loaded, Error>, cx| match result {
                Ok(loaded) => {
                    let error = loaded.settings.error.is_some();
                    this.settings = Some(loaded.settings);
                    this.runs = loaded.runs;
                    this.failed = false;
                    if error {
                        let text = Self::copy(cx).request_failed;
                        toast::show(cx, Toast::error(text));
                    }
                }
                Err(_) => this.failed = true,
            },
        );
    }

    /// `save`: PUT the whole list at the revision it was read at.
    fn save(&mut self, hooks: &[HookDefinition], cx: &mut Context<Self>) {
        let Some(settings) = &self.settings else {
            return;
        };
        self.busy = true;
        let body = json!({
            "revision": settings.revision,
            "config": { "version": 1, "hooks": hooks },
        });
        fetch(
            cx,
            move |client| async move { client.save_hooks(&body).await },
            |this: &mut Self, result: Result<HookSettings, Error>, cx| {
                this.busy = false;
                match result {
                    Ok(saved) => {
                        this.settings = Some(saved);
                        this.editing = None;
                    }
                    Err(_) => {
                        let text = Self::copy(cx).request_failed;
                        toast::show(cx, Toast::error(text));
                        Self::refresh(cx);
                    }
                }
            },
        );
    }

    /// The form's Save: the hook replaces its entry, or is added.
    fn commit(&mut self, cx: &mut Context<Self>) {
        let Some(form) = &self.editing else {
            return;
        };
        let Some(hook) = form.result() else {
            let copy = Self::copy(cx);
            toast::show(cx, Toast::error(copy.args));
            return;
        };
        let mut hooks = self.hooks().to_vec();
        match hooks.iter_mut().find(|existing| existing.id == hook.id) {
            Some(existing) => *existing = hook,
            None => hooks.push(hook),
        }
        self.save(&hooks, cx);
    }

    /// `test`: run one hook and say how it went.
    fn test(&mut self, id: String, cx: &mut Context<Self>) {
        self.busy = true;
        fetch(
            cx,
            move |client| async move { client.test_hook(&id).await },
            |this: &mut Self, result: Result<HookRun, Error>, cx| {
                this.busy = false;
                let copy = Self::copy(cx);
                match result {
                    Ok(run) => {
                        let ok = run.outcome == "continue";
                        let label = if ok {
                            copy.test_success
                        } else {
                            copy.test_failure
                        };
                        let text = format!("{label} · {} ms", run.duration_ms);
                        toast::show(
                            cx,
                            if ok {
                                Toast::success(text)
                            } else {
                                Toast::error(text)
                            },
                        );
                        Self::refresh(cx);
                    }
                    Err(_) => {
                        toast::show(cx, Toast::error(copy.request_failed));
                    }
                }
            },
        );
    }

    /// `remove`: after the owner confirms.
    fn remove(&mut self, hook: &HookDefinition, cx: &mut Context<Self>) {
        let copy = Self::copy(cx);
        let rest: Vec<HookDefinition> = self
            .hooks()
            .iter()
            .filter(|other| other.id != hook.id)
            .cloned()
            .collect();
        let request = Request::new((copy.delete_confirm)(hook.title()))
            .title(copy.delete)
            .confirm_label(copy.delete)
            .destructive();
        let weak = cx.entity().downgrade();
        self.ctx.confirm(
            request,
            move |_, cx| {
                let _ = weak.update(cx, |page, cx| page.save(&rest, cx));
            },
            cx,
        );
    }

    /// The row's on/off switch: saves the whole list with this hook flipped.
    fn enabled_switch(&self, hook: &HookDefinition, cx: &mut Context<Self>) -> Switch {
        let (busy, id) = (self.busy, &hook.id);
        let weak = cx.entity().downgrade();
        let toggled = hook.clone();
        Switch::new(SharedString::from(format!("hook-enabled-{id}")))
            .checked(hook.enabled)
            .when(busy, Switch::disabled)
            .on_checked_change(move |enabled, _, cx| {
                let _ = weak.update(cx, |page, cx| {
                    let hooks: Vec<_> = page
                        .hooks()
                        .iter()
                        .map(|other| {
                            let mut other = other.clone();
                            if other.id == toggled.id {
                                other.enabled = enabled;
                            }
                            other
                        })
                        .collect();
                    page.save(&hooks, cx);
                });
            })
    }

    /// `HookRow`
    fn row(
        &self,
        hook: &HookDefinition,
        copy: &'static HooksCopy,
        frame: &'static Words,
        cx: &mut Context<Self>,
    ) -> CardListItem {
        let toggle = self.enabled_switch(hook, cx);
        let busy = self.busy;
        let ds = Ds::get(cx);
        let glyph = |glyph: Icon| icon(glyph, IconSize::Sm, ds);
        let reason =
            |label: &'static str| Some(SharedString::from(if busy { frame.saving } else { label }));
        let id = &hook.id;
        let (test_hook, edit_hook, remove_hook) = (hook.id.clone(), hook.clone(), hook.clone());
        let icon_button = |name: &str, glyph_icon: Icon| {
            Button::new(SharedString::from(format!("hook-{name}-{id}")))
                .size(ButtonSize::IconXs)
                .variant(Variant::Outline)
                .icon_start(glyph(glyph_icon))
                .when(busy, Button::disabled)
        };
        let actions = button::container(ButtonSize::IconXs)
            .child(tip(
                format!("hook-test-tip-{id}"),
                reason(copy.test),
                icon_button("test", Icon::RefreshCcw)
                    .on_click(cx.listener(move |page, _, _, cx| page.test(test_hook.clone(), cx))),
            ))
            .child(toggle)
            .child(tip(
                format!("hook-edit-tip-{id}"),
                reason(copy.edit),
                icon_button("edit", Icon::PencilLine).on_click(cx.listener(
                    move |page, _, _, cx| {
                        page.editing = Some(Form::new(edit_hook.clone()));
                        cx.notify();
                    },
                )),
            ))
            .child(tip(
                format!("hook-remove-tip-{id}"),
                reason(copy.remove),
                icon_button("remove", Icon::Trash2)
                    .on_click(cx.listener(move |page, _, _, cx| page.remove(&remove_hook, cx))),
            ));
        let summary = [
            Some(hook.event.clone()),
            Some(hook.matcher.tools.join(", ")),
            hook.command
                .clone()
                .or_else(|| hook.args.as_ref().map(|args| args.join(" "))),
        ]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
        let state = if hook.enabled {
            copy.enabled
        } else {
            copy.disabled
        };
        CardListItem::new(
            SharedString::from(format!("hook-{id}")),
            hook.title().to_owned(),
        )
        .meta(Typo::caption(state))
        .description(summary)
        .actions(actions)
    }

    /// The `hooks` section: the list and Add.
    fn hooks_section(
        &self,
        copy: &'static HooksCopy,
        frame: &'static Words,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let state = match (&self.settings, self.failed) {
            (Some(_), _) if self.hooks().is_empty() => SettingsSectionState::Empty,
            (Some(_), _) => SettingsSectionState::Ready,
            (None, true) => SettingsSectionState::Error,
            (None, false) => SettingsSectionState::Loading,
        };
        let rows: Vec<CardListItem> = self
            .hooks()
            .iter()
            .map(|hook| self.row(hook, copy, frame, cx))
            .collect();
        let add = Button::new("hook-add")
            .size(ButtonSize::Sm)
            .variant(Variant::Outline)
            .icon_start(icon(Icon::Plus, IconSize::Md, Ds::get(cx)))
            .text(copy.add)
            .when(self.busy, Button::disabled)
            .on_click(cx.listener(|page, _, _, cx| {
                page.editing = Some(Form::new(HookDefinition::empty()));
                cx.notify();
            }));
        SettingsSection::new("hooks", SettingsSectionKind::List, copy.title)
            .state(state)
            .empty_message(copy.empty)
            .on_retry(cx.listener(|_, _, _, cx| Self::refresh(cx)))
            .actions(add)
            .child(CardList::new("hooks-list").flush().children(rows))
    }

    /// The `hook-runs` section.
    fn runs_section(&self, copy: &'static HooksCopy, cx: &mut Context<Self>) -> SettingsSection {
        let weak = cx.entity().downgrade();
        let on_toggle: OnToggle = Rc::new(move |index, _, cx| {
            let _ = weak.update(cx, |page, cx| {
                page.expanded = if page.expanded == Some(index) {
                    None
                } else {
                    Some(index)
                };
                cx.notify();
            });
        });
        let refresh = Button::new("hook-runs-refresh")
            .size(ButtonSize::Sm)
            .variant(Variant::Outline)
            .text(copy.refresh)
            .when(self.busy, Button::disabled)
            .on_click(cx.listener(|_, _, _, cx| Self::refresh(cx)));
        let state = if self.runs.is_empty() {
            SettingsSectionState::Empty
        } else {
            SettingsSectionState::Ready
        };
        SettingsSection::new("hook-runs", SettingsSectionKind::List, copy.recent)
            .state(state)
            .empty_message(copy.empty_runs)
            .actions(refresh)
            .child(runs_list(&self.runs, self.expanded, copy, &on_toggle))
    }

    /// The add/edit dialog; closing it is refused while a save is running.
    fn dialog(
        &self,
        copy: &'static HooksCopy,
        frame: &'static Words,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let weak = cx.entity().downgrade();
        let dialog = Dialog::new("hook-dialog", window, cx)
            .open(self.editing.is_some())
            .on_open_change(move |open, _, cx| {
                if !open {
                    let _ = weak.update(cx, |page, cx| {
                        if !page.busy {
                            page.editing = None;
                            cx.notify();
                        }
                    });
                }
            });
        let content = match &self.editing {
            Some(form) => self.form_content(form, copy, frame, cx),
            None => DialogContent::new(),
        };
        dialog.content(content, window, cx)
    }
}

impl Render for HooksPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = Ds::get(cx).lang();
        let (copy, frame) = (words(lang), frame_words(lang));
        let page = SettingsPage::new()
            .labels(SectionCtx::labels(cx))
            .section(self.hooks_section(copy, frame, cx))
            .section(self.runs_section(copy, cx));
        div()
            .w_full()
            .child(page)
            .child(self.dialog(copy, frame, window, cx))
    }
}
