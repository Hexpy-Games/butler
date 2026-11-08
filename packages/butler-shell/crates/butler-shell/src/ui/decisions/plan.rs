//! `ComposerPlanDecisionSurface`, `useComposerPlanDecision`, `ComposerPlanInstructionContext` and
//! `PlanDocumentMessage`.
//!
//! The React hook reads the composer store and the Butler store; here the composer and the Store
//! register a [`PlanBridge`] and the gate ([`set_plan_gate`]) once, and this file keeps the
//! hook's own state (`pending`, `instructionPlanId`).
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::composer_decision_panel::{Action, ComposerDecisionPanel};
use butler_ds::ui::blocks::composer_panel::Placement;
use butler_ds::ui::blocks::markdown_content::MarkdownContent;
use butler_ds::ui::blocks::surface_panel::{Elevation, SurfacePanel};
use butler_ds::ui::button::Variant;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::tag::Tag;
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::Typo;
use gpui::{
    AnyElement, App, Global, IntoElement as _, ParentElement as _, SharedString, Styled as _,
    Window, div,
};
use serde_json::{Value, json};

use super::DecisionCtx;
use crate::ui::i18n::plan_decision::words;
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::{
    MessageRecord, MessageRecordRole, PlanDecisionResultView, PlanDocumentRecord,
    QueuedMessageRecord, QueuedMessageRecordState, SessionView,
};

/// `ACTIVE_TURN_STATES` (app/constants.ts).
const ACTIVE_TURN_STATES: [&str; 7] = [
    "accepted",
    "thinking",
    "streaming",
    "waiting_for_form",
    "waiting_for_tool",
    "cancelling",
    "retrying",
];

type OpenPlan = Rc<dyn Fn(&str, &mut App)>;
type Decided = Rc<dyn Fn(&PlanDecisionResultView, &mut App)>;

/// What the plan decision needs from the composer and the Store; registered once.
#[derive(Clone)]
pub(crate) struct PlanBridge {
    /// `onOpenPlan`: scrolls the transcript to the plan document of this plan id.
    pub(crate) open_plan: OpenPlan,
    /// `useComposerStore.getState().text`
    pub(crate) text: Rc<dyn Fn(&mut App) -> String>,
    /// `setText("")`
    pub(crate) clear_text: Rc<dyn Fn(&mut App)>,
    /// `setEngaged(true)` and `focusComposer`
    pub(crate) open_instruction: Rc<dyn Fn(&mut App)>,
    /// After an accepted decision: `applyServerPlanMode(result.controls.controls.plan_mode)`, the
    /// plan document and queue of the result into the Store, and `refreshSessionView`.
    pub(crate) decided: Decided,
}

/// The hook's state (`pending`, `instructionPlanId`) and the gate its inputs make.
#[derive(Default)]
struct PlanState {
    plan_mode: bool,
    queued_plans: Vec<String>,
    editing: Option<String>,
    pending: bool,
    bridge: Option<PlanBridge>,
}

impl Global for PlanState {}

pub(crate) fn set_plan_bridge(cx: &mut App, bridge: PlanBridge) {
    cx.default_global::<PlanState>().bridge = Some(bridge);
}

/// The composer's `planMode` and the session queue (`planQueued`): the plan ids with a queued or
/// dispatching message.
pub(crate) fn set_plan_gate(cx: &mut App, plan_mode: bool, queue: &[QueuedMessageRecord]) {
    let state = cx.default_global::<PlanState>();
    state.plan_mode = plan_mode;
    state.queued_plans = queue
        .iter()
        .filter(|message| {
            matches!(
                message.state,
                QueuedMessageRecordState::Queued | QueuedMessageRecordState::Dispatching
            )
        })
        .filter_map(|message| message.plan_id.clone())
        .collect();
}

/// `latestActionablePlan`
fn latest_actionable_plan(messages: &[MessageRecord]) -> Option<&PlanDocumentRecord> {
    let message = messages
        .iter()
        .rev()
        .find(|message| message.role == MessageRecordRole::Assistant)?;
    let plan = message.plan_document.as_ref()?;
    let status = plan.status.to_lowercase();
    ["draft", "pending", "awaiting"]
        .iter()
        .any(|word| status.contains(word))
        .then_some(plan)
}

fn active_turn(view: &SessionView) -> bool {
    view.active_turn
        .as_ref()
        .is_some_and(|turn| ACTIVE_TURN_STATES.contains(&turn.state.as_str()))
}

/// `useComposerPlanDecision`'s gate: the plan that waits for a decision.
fn actionable<'a>(ctx: DecisionCtx<'a>, cx: &App) -> Option<&'a PlanDocumentRecord> {
    let state = cx.try_global::<PlanState>()?;
    let plan = latest_actionable_plan(&ctx.view.messages)?;
    (state.plan_mode && !state.queued_plans.contains(&plan.id) && !active_turn(ctx.view))
        .then_some(plan)
}

fn bridge(cx: &App) -> Option<PlanBridge> {
    cx.try_global::<PlanState>()?.bridge.clone()
}

fn pending(cx: &App) -> bool {
    cx.try_global::<PlanState>()
        .is_some_and(|state| state.pending)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Decision {
    Accept,
    Reject,
    Instruct,
}

/// `decide`: posts the decision; an instruction is the composer's text.
fn decide(decision: Decision, session_id: String, plan_id: &str, cx: &mut App) {
    let Some(bridge) = bridge(cx) else { return };
    let (action, instruction) = match decision {
        Decision::Accept => ("accept", None),
        Decision::Reject => ("reject", None),
        Decision::Instruct => {
            let text = (bridge.text)(cx).trim().to_owned();
            if text.is_empty() {
                return;
            }
            ("instruct", Some(text))
        }
    };
    cx.default_global::<PlanState>().pending = true;
    cx.refresh_windows();
    let mut body = json!({ "action": action });
    if let (Some(text), Value::Object(fields)) = (instruction, &mut body) {
        fields.insert("instruction".into(), Value::String(text));
    }
    let (session, plan) = (session_id.clone(), plan_id.to_owned());
    let done = Jobs::run(cx, move |client| async move {
        let value = client
            .decide_session_plan(&session, &plan, &body)
            .await
            .ok()?;
        serde_json::from_value::<PlanDecisionResultView>(value).ok()
    });
    cx.spawn(async move |cx| {
        let result = done.await.flatten();
        cx.update(|cx| finish(decision, &session_id, result, &bridge, cx));
    })
    .detach();
}

/// The end of `decide`: an accepted decision for this session reaches the composer and Store.
fn finish(
    decision: Decision,
    session_id: &str,
    result: Option<PlanDecisionResultView>,
    bridge: &PlanBridge,
    cx: &mut App,
) {
    cx.default_global::<PlanState>().pending = false;
    match result {
        Some(result) if result.controls.session_id == session_id => {
            (bridge.decided)(&result, cx);
            if decision == Decision::Instruct {
                (bridge.clear_text)(cx);
                cx.default_global::<PlanState>().editing = None;
            }
        }
        Some(_) => {}
        None => {
            let failed = words(Ds::get(cx).lang()).decision_failed;
            toast::show(cx, Toast::error(failed));
        }
    }
    cx.refresh_windows();
}

/// `onOpenInstruction`
fn open_instruction(plan_id: &str, cx: &mut App) {
    let Some(bridge) = bridge(cx) else { return };
    cx.default_global::<PlanState>().editing = Some(plan_id.to_owned());
    (bridge.open_instruction)(cx);
    cx.refresh_windows();
}

/// A plan waits for a decision and the owner is not writing its instruction.
pub(super) fn waiting(ctx: DecisionCtx<'_>, cx: &App) -> bool {
    actionable(ctx, cx).is_some_and(|plan| {
        cx.try_global::<PlanState>()
            .is_some_and(|state| state.editing.as_deref() != Some(plan.id.as_str()))
    })
}

/// `ComposerPlanDecisionSurface`; `None` when no plan waits for a decision, or the owner is
/// writing the instruction (`editingInstruction`).
pub(crate) fn plan_surface(
    ctx: DecisionCtx<'_>,
    placement: Placement,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let _ = window;
    let plan = actionable(ctx, cx)?;
    if cx.global::<PlanState>().editing.as_deref() == Some(plan.id.as_str()) {
        return None;
    }
    let copy = words(Ds::get(cx).lang());
    let (session, id) = (ctx.view.session_id.clone(), plan.id.clone());
    let open_id = id.clone();
    let action = |decision: Decision, label: &'static str, variant: Variant| {
        let (session, id) = (session.clone(), id.clone());
        Action::new(label, variant, move |_, cx| {
            if !pending(cx) {
                decide(decision, session.clone(), &id, cx);
            }
        })
        .deferred()
    };
    let instruction = {
        let id = id.clone();
        Action::new(copy.instruction, Variant::Outline, move |_, cx| {
            if !pending(cx) {
                open_instruction(&id, cx);
            }
        })
    };
    Some(
        ComposerDecisionPanel::new(
            "composer-plan-decision",
            Icon::ListChecks,
            plan.title.clone(),
            move |_, _, cx| {
                if let Some(bridge) = bridge(cx) {
                    (bridge.open_plan)(&open_id, cx);
                }
            },
        )
        .placement(placement)
        .eyebrow(copy.plan)
        .action(instruction)
        .action(action(Decision::Reject, copy.reject, Variant::Secondary))
        .action(action(Decision::Accept, copy.accept, Variant::Default))
        .into_any_element(),
    )
}

/// `ComposerPlanInstructionContext`'s inputs: the attachment above the composer's text area.
pub(crate) struct PlanInstructionContext {
    pub(crate) title: SharedString,
    pub(crate) label: &'static str,
    pub(crate) placeholder: &'static str,
}

/// The instruction context while the owner writes feedback for the waiting plan.
pub(crate) fn plan_instruction(ctx: DecisionCtx<'_>, cx: &App) -> Option<PlanInstructionContext> {
    let plan = actionable(ctx, cx)?;
    if cx.global::<PlanState>().editing.as_deref() != Some(plan.id.as_str()) {
        return None;
    }
    let copy = words(Ds::get(cx).lang());
    Some(PlanInstructionContext {
        title: plan.title.clone().into(),
        label: copy.instruction_active,
        placeholder: copy.instruction_placeholder,
    })
}

/// `onShowDecision`
pub(crate) fn show_plan_decision(cx: &mut App) {
    cx.default_global::<PlanState>().editing = None;
    cx.refresh_windows();
}

/// `onSubmitInstruction`
pub(crate) fn submit_plan_instruction(ctx: DecisionCtx<'_>, cx: &mut App) {
    if let Some(plan) = actionable(ctx, cx) {
        decide(
            Decision::Instruct,
            ctx.view.session_id.clone(),
            &plan.id,
            cx,
        );
    }
}

/// `projectDocumentMarkdownView`'s body: the Markdown without its front matter.
fn markdown_body(markdown: &str) -> &str {
    let Some(rest) = markdown
        .strip_prefix("---\r\n")
        .or_else(|| markdown.strip_prefix("---\n"))
    else {
        return markdown;
    };
    let Some(end) = rest.find("\n---") else {
        return markdown;
    };
    rest[end + 4..].trim_start()
}

/// `PlanDocumentMessage` of one plan.
pub(crate) fn plan_document_card(
    plan: &PlanDocumentRecord,
    bubble: bool,
    cx: &mut App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let spacer = (!bubble).then(|| div().h(Space::Sm.px(ds)));
    let mut header = Stack::row()
        .gap(Space::Sm)
        .cross(Cross::Center)
        .child(icon(Icon::ListChecks, IconSize::Md, ds))
        .child(Typo::label(plan.title.clone()).truncate());
    if !plan.status.is_empty() {
        header = header.child(Tag::new(
            SharedString::from(format!("plan-status-{}", plan.id)),
            plan.status.clone(),
        ));
    }
    let body = MarkdownContent::new(
        SharedString::from(format!("plan-document-{}", plan.id)),
        markdown_body(&plan.markdown).to_owned(),
    );
    div()
        .flex()
        .flex_col()
        .children(spacer)
        .child(
            SurfacePanel::new()
                .elevation(Elevation::Subtle)
                .child(Stack::new().gap(Space::Md).child(header).child(body)),
        )
        .into_any_element()
}
