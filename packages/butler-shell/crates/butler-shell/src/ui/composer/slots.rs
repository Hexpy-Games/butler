//! The toolbar's controls: the attachment menu, the access, workspace, plan, context and model
//! controls, each over the composer's state and its handlers.
use std::rc::Rc;

use butler_ds::ui::context::Ds;
use gpui::{Context, IntoElement as _, SharedString, Window};

use super::Composer;
use super::attachments::menu::{AttachmentMenu, attachment_menu};
use super::menus::{
    ModelMenuProps, access_mode_menu, model_menu, plan_mode_badge, workspace_select,
};
use super::state::{
    AttachmentPickerKind, ComposerModelState, ComposerState, ImageRefusal, available_reasoning,
    composer_image_policy, image_refusal_label, runtime_models,
};
use super::toolbar::ToolbarSlots;

impl Composer {
    /// The menu, context and attachment controls.
    pub(super) fn control_slots(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> ToolbarSlots {
        let weak = cx.entity().downgrade();
        let lang = Ds::get(cx).lang();
        let shown = self.controls.shown.clone();
        let policy = composer_image_policy(self.active_model());
        let images_blocked: Option<SharedString> = (!policy.accepts).then(|| {
            let refusal = policy.blocked_by.map_or(ImageRefusal::Model, Into::into);
            image_refusal_label(refusal, lang).into()
        });
        let (uploading, workspace_mode) =
            ComposerState::read(cx, |draft| (draft.uploading_count, draft.workspace_mode));
        let (pick, plan, document) = (weak.clone(), weak.clone(), weak.clone());
        let attach = attachment_menu(
            &AttachmentMenu {
                uploading: uploading > 0,
                project_id: self.inputs.project_id.clone(),
                plan_mode: shown.plan_mode,
                images_blocked,
                on_pick_file: Rc::new(move |images, _, cx| {
                    let kind = if images {
                        AttachmentPickerKind::Images
                    } else {
                        AttachmentPickerKind::Files
                    };
                    let _ = pick.update(cx, |this, cx| this.open_picker(kind, cx));
                }),
                on_plan_mode: Rc::new(move |on, _, cx| {
                    let _ = plan.update(cx, |this, cx| this.set_plan_mode(on, cx));
                }),
                on_document: Rc::new(move |chosen, _, cx| {
                    let chosen = chosen.clone();
                    let _ = document.update(cx, |this, cx| this.add_document(&chosen, cx));
                }),
            },
            window,
            cx,
        );
        let access = {
            let weak = weak.clone();
            access_mode_menu(
                &shown.access_mode,
                Rc::new(move |mode, _, cx| {
                    let _ = weak.update(cx, |this, cx| this.set_access_mode(mode, cx));
                }),
                window,
                cx,
            )
        };
        let workspace = {
            let weak = weak.clone();
            workspace_select(
                self.inputs.git.project && self.inputs.session_id.is_none(),
                workspace_mode,
                false,
                Rc::new(move |mode, _, cx| {
                    let _ = weak.update(cx, |_, cx| {
                        ComposerState::update(cx, |draft| draft.workspace_mode = mode);
                        cx.notify();
                    });
                }),
                window,
                cx,
            )
        };
        let plan_badge = {
            let weak = weak.clone();
            plan_mode_badge(
                shown.plan_mode,
                move |_, cx| {
                    let _ = weak.update(cx, |this, cx| this.set_plan_mode(false, cx));
                },
                cx,
            )
        };
        let active = self.active_model().cloned();
        let on_model = {
            let weak = weak.clone();
            Rc::new(
                move |chosen: &super::menus::ModelChoice, _: &mut Window, cx: &mut gpui::App| {
                    let chosen = chosen.clone();
                    let _ = weak.update(cx, |this, cx| this.choose_model(&chosen, cx));
                },
            )
        };
        let on_reasoning = {
            let weak = weak.clone();
            Rc::new(
                move |effort: &crate::ui::source::wire::ReasoningEffort,
                      _: &mut Window,
                      cx: &mut gpui::App| {
                    let _ = weak.update(cx, |this, cx| this.set_reasoning(effort, cx));
                },
            )
        };
        let model = model_menu(
            ModelMenuProps {
                state: shown.state,
                available_reasoning: available_reasoning(active.as_ref()),
                active,
                unavailable: shown
                    .metadata
                    .clone()
                    .filter(|_| shown.state == ComposerModelState::Unavailable),
                model: shown.model.clone().into(),
                models: runtime_models(&self.controls.catalog)
                    .into_iter()
                    .cloned()
                    .collect(),
                reasoning: shown.reasoning.clone(),
                on_model,
                on_reasoning,
            },
            window,
            cx,
        );
        ToolbarSlots {
            attach,
            access,
            workspace,
            plan: plan_badge,
            context: self.context_control.clone().into_any_element(),
            model,
        }
    }
}
