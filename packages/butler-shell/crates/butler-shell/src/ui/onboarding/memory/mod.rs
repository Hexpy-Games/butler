//! The memory step (`FirstRunMemory`, `useMemoryChoice`): a required pick between the memory
//! model and basic memory; Continue saves it and only "on" starts the download in the background.
mod copy;
pub(crate) mod status;

use butler_ds::ui::blocks::choice_card::{ChoiceCard, ChoiceCardList, ChoiceState, glyph};
use butler_ds::ui::blocks::setup_wizard_step_card::SetupWizardStepAction;
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast, ToastId};
use butler_ds::ui::tooltip::{Side, Tooltip};
use butler_shell_client::Error;
use gpui::{
    AnyElement, Context, Entity, EventEmitter, IntoElement as _, ParentElement as _, Window,
};
use serde_json::{Value, json};

use self::copy::words;
use super::Onboarding;
use super::card::step_card;
use super::copy::words as shared;
use super::readiness::{MemoryModel, Readiness, ReadinessView};
use crate::ui::Icon;
use crate::ui::settings::state::fetch;

/// The choice was saved.
pub(crate) enum MemoryEvent {
    Saved,
}

/// `useMemoryChoice`: the pick (not yet saved) and the save in flight.
pub(crate) struct MemoryChoice {
    picked: Option<bool>,
    saving: bool,
    /// The `first-run-memory` toast, replaced by the next failure's.
    toast: Option<ToastId>,
}

impl EventEmitter<MemoryEvent> for MemoryChoice {}

impl MemoryChoice {
    pub(crate) fn new(cx: &mut Context<Self>) -> Self {
        let _ = cx;
        Self {
            picked: None,
            saving: false,
            toast: None,
        }
    }

    pub(crate) fn saving(&self) -> bool {
        self.saving
    }

    /// `picked ?? memoryModelChoice(model)`: on once chosen (downloading, ready or failed), off
    /// for `off`, none while unset.
    fn value(&self, model: Option<&MemoryModel>) -> Option<bool> {
        self.picked.or_else(|| {
            model
                .map(|model| &*model.state)
                .filter(|state| *state != "unset")
                .map(|state| state != "off")
        })
    }

    fn pick(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.picked = Some(enabled);
        cx.notify();
    }

    /// Saves the choice, hands the readiness answer to `readiness`, then emits
    /// [`MemoryEvent::Saved`].
    pub(crate) fn choose(
        &mut self,
        enabled: bool,
        readiness: Entity<Readiness>,
        cx: &mut Context<Self>,
    ) {
        if self.saving {
            return;
        }
        self.saving = true;
        cx.notify();
        let body = json!({ "enabled": enabled });
        fetch(
            cx,
            move |client| async move { client.choose_memory_model(&body).await },
            move |this: &mut Self, result: Result<Value, Error>, cx| {
                this.saving = false;
                match result {
                    Ok(answer) => {
                        // `chooseModel`: the answer is the Agent's readiness view.
                        if let Some(view) = ReadinessView::from_value(&answer) {
                            readiness.update(cx, |readiness, cx| readiness.set(view, cx));
                        }
                        cx.emit(MemoryEvent::Saved);
                    }
                    Err(_) => {
                        let toast = Toast::error(words(Ds::get(cx).lang()).save_failed);
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
}

pub(crate) fn screen(
    view: &Onboarding,
    _window: &mut Window,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let copy = words(view.lang);
    let model = view.readiness.read(cx).view().memory_model.clone();
    let choice = view.memory.read(cx);
    let value = choice.value(model.as_ref());
    let saving = choice.saving();
    let waiting = model.is_none();
    let size_mb = model
        .as_ref()
        .filter(|model| model.bytes_total > 0)
        .map(|model| status::megabytes(model.bytes_total));
    let state = if saving {
        ChoiceState::Disabled
    } else {
        ChoiceState::Default
    };
    let mut on = ChoiceCard::new("first-run-memory-on", glyph(Icon::Sparkles, cx), copy.on)
        .description(copy.description)
        .chevron(false)
        .selected(value == Some(true))
        .state(state)
        .on_click(cx.listener(|view, _, _, cx| {
            view.memory.update(cx, |memory, cx| memory.pick(true, cx));
        }));
    if let Some(size_mb) = size_mb {
        on = on.meta(format!("{size_mb} MB"));
    }
    let off = ChoiceCard::new("first-run-memory-off", glyph(Icon::FileText, cx), copy.off)
        .description(copy.off_description)
        .chevron(false)
        .selected(value == Some(false))
        .state(state)
        .on_click(cx.listener(|view, _, _, cx| {
            view.memory.update(cx, |memory, cx| memory.pick(false, cx));
        }));
    let readiness = view.readiness.clone();
    let mut action = SetupWizardStepAction::new("first-run-memory-continue", copy.continue_)
        .forward()
        .on_click(cx.listener(move |view, _, _, cx| {
            if let Some(enabled) = value {
                let readiness = readiness.clone();
                view.memory
                    .update(cx, |memory, cx| memory.choose(enabled, readiness, cx));
            }
        }));
    if value.is_none() || saving || waiting {
        action = action.disabled();
    }
    let mut tooltip = Tooltip::new("first-run-memory-waiting").side(Side::Top);
    if waiting {
        tooltip = tooltip.label(copy.prep_working);
    }
    step_card(
        view,
        copy.title,
        [ChoiceCardList::new()
            .child(on)
            .child(off)
            .into_any_element()],
        cx,
    )
    .description(copy.lede)
    .on_back(
        shared(view.lang).back,
        cx.listener(|view, _, _, cx| view.back_to_consent(cx)),
    )
    .action(tooltip.child(action))
    .into_any_element()
}
