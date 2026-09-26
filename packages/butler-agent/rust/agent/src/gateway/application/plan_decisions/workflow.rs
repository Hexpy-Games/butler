use serde_json::json;

use super::super::{
    AppApplication, GatewayApplicationError, app_error, events, settings,
    settings::PlanContinuation,
};
use super::contracts::{
    AppPlanDecisionAction, AppPlanDecisionDocument, AppPlanDecisionPlan, AppPlanDecisionRequest,
    AppPlanDecisionResult, AppPlanDecisionStatus,
};
use super::helpers::{
    DecisionProject, decision_gate, decision_project, map_decision_project_error, map_read_error,
    normalized_plan,
};
use crate::{gateway::application::storage::AppStorageError, public_text::trim_js_whitespace};

impl AppApplication {
    pub(in crate::gateway::application) async fn decide_session_plan_owned(
        &self,
        session_id: String,
        plan_id: String,
        request: AppPlanDecisionRequest,
    ) -> Result<AppPlanDecisionResult, GatewayApplicationError> {
        let session_id = trim_js_whitespace(&session_id).to_owned();
        let plan_id = trim_js_whitespace(&plan_id).to_owned();
        if session_id.is_empty() || plan_id.is_empty() || plan_id.encode_utf16().count() > 256 {
            return Err(public(
                400,
                "invalid_plan_reference",
                "A session and Project Ledger Plan are required.",
            ));
        }
        let _decision = self
            .plan_decision_locks
            .acquire(format!("{session_id}\0{plan_id}"))
            .await;
        let project = self
            .storage
            .execute({
                let session_id = session_id.clone();
                let plan_id = plan_id.clone();
                move |db| decision_project(db, &session_id, &plan_id)
            })
            .await
            .map_err(map_decision_project_error)?;
        let mut plan = self
            .dependencies
            .plan_decision_ledger
            .read_plan(
                project.app_project_id.clone(),
                project.ledger_project_id.clone(),
                plan_id.clone(),
            )
            .await
            .map_err(map_read_error)?
            .and_then(|plan| normalized_plan(plan, &plan_id))
            .ok_or_else(|| public(404, "plan_not_found", "Project Ledger Plan not found."))?;
        if plan.status != "draft" {
            return Err(public(
                409,
                "plan_decision_conflict",
                "This Project Ledger Plan has already received a decision.",
            ));
        }
        let (active_turn, pending_plan) = self
            .storage
            .execute({
                let session_id = session_id.clone();
                let plan_id = plan_id.clone();
                move |db| decision_gate(db, &session_id, &plan_id)
            })
            .await
            .map_err(app_error)?;
        if active_turn || pending_plan {
            return Err(public(
                409,
                "plan_decision_in_progress",
                "The current Plan decision is still being processed.",
            ));
        }

        match request.action {
            AppPlanDecisionAction::Accept | AppPlanDecisionAction::Reject => {
                let status = if request.action == AppPlanDecisionAction::Accept {
                    AppPlanDecisionStatus::Active
                } else {
                    AppPlanDecisionStatus::Rejected
                };
                self.dependencies
                    .plan_decision_ledger
                    .update_plan_status(
                        project.app_project_id.clone(),
                        project.ledger_project_id.clone(),
                        plan_id.clone(),
                        status,
                    )
                    .await
                    .map_err(|_| {
                        public(
                            409,
                            "plan_update_failed",
                            "Project Ledger Plan could not be updated.",
                        )
                    })?;
                plan = self
                    .read_plan(&project, &plan_id)
                    .await?
                    .ok_or(GatewayApplicationError::Internal)?;
                let controls = self
                    .update_session_controls_view_owned(
                        session_id.clone(),
                        super::super::AppSessionControlUpdate {
                            plan_mode: Some(false),
                            ..Default::default()
                        },
                    )
                    .await?;
                let queued = if request.action == AppPlanDecisionAction::Accept {
                    Some(self.queue_continuation(&session_id, &plan).await?)
                } else {
                    None
                };
                self.record_decision(&session_id, &plan, request.action)
                    .await?;
                Ok(AppPlanDecisionResult {
                    plan_document: self.plan_document(plan),
                    controls,
                    queued,
                })
            }
            AppPlanDecisionAction::Instruct => {
                let instruction = request
                    .instruction
                    .as_deref()
                    .map(trim_js_whitespace)
                    .unwrap_or_default();
                if instruction.is_empty() {
                    return Err(public(
                        400,
                        "plan_instruction_required",
                        "A direct Plan instruction is required.",
                    ));
                }
                let queued = self
                    .queue_instruction(&session_id, &plan, instruction)
                    .await?;
                let controls = self
                    .update_session_controls_view_owned(
                        session_id.clone(),
                        super::super::AppSessionControlUpdate {
                            plan_mode: Some(true),
                            ..Default::default()
                        },
                    )
                    .await?;
                self.record_decision(&session_id, &plan, request.action)
                    .await?;
                Ok(AppPlanDecisionResult {
                    plan_document: self.plan_document(plan),
                    controls,
                    queued: Some(queued),
                })
            }
        }
    }

    async fn read_plan(
        &self,
        project: &DecisionProject,
        plan_id: &str,
    ) -> Result<Option<AppPlanDecisionPlan>, GatewayApplicationError> {
        self.dependencies
            .plan_decision_ledger
            .read_plan(
                project.app_project_id.clone(),
                project.ledger_project_id.clone(),
                plan_id.to_owned(),
            )
            .await
            .map_err(map_read_error)
            .map(|plan| plan.and_then(|plan| normalized_plan(plan, plan_id)))
    }

    async fn queue_continuation(
        &self,
        session_id: &str,
        plan: &AppPlanDecisionPlan,
    ) -> Result<crate::gateway::SessionQueueView, GatewayApplicationError> {
        self.dependencies.settings_facts.refresh().await?;
        let facts = self.dependencies.settings_facts.snapshot()?;
        let now = self.dependencies.identity_clock.now_iso();
        let input = PlanContinuation {
            queued_id: format!("queued-{}", self.dependencies.identity_clock.new_uuid()),
            client_message_id: format!(
                "client-plan-accept-{}",
                self.dependencies.identity_clock.new_uuid()
            ),
            chat_id: session_id.to_owned(),
            plan_id: plan.id.clone(),
            plan_title: plan.title.clone(),
            facts,
        };
        let subscribers = self.subscribers.clone();
        let chat_id = session_id.to_owned();
        self.storage
            .execute(move |db| {
                let transaction = db.transaction().map_err(AppStorageError::sqlite)?;
                settings::create_plan_continuation(&transaction, &subscribers, input, &now)?;
                transaction.commit().map_err(AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)?;
        self.queue_wake.drain_chat(chat_id.clone()).await?;
        self.queue_page(chat_id).await
    }

    async fn queue_instruction(
        &self,
        session_id: &str,
        plan: &AppPlanDecisionPlan,
        instruction: &str,
    ) -> Result<crate::gateway::SessionQueueView, GatewayApplicationError> {
        self.dependencies.settings_facts.refresh().await?;
        let facts = self.dependencies.settings_facts.snapshot()?;
        let now = self.dependencies.identity_clock.now_iso();
        let input = settings::PlanInstruction {
            queued_id: format!("queued-{}", self.dependencies.identity_clock.new_uuid()),
            client_message_id: format!(
                "client-plan-instruct-{}",
                self.dependencies.identity_clock.new_uuid()
            ),
            chat_id: session_id.to_owned(),
            plan_id: plan.id.clone(),
            text: instruction.to_owned(),
            facts,
        };
        let subscribers = self.subscribers.clone();
        let chat_id = session_id.to_owned();
        self.storage
            .execute(move |db| {
                let transaction = db.transaction().map_err(AppStorageError::sqlite)?;
                settings::create_plan_instruction(&transaction, &subscribers, input, &now)?;
                transaction.commit().map_err(AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)?;
        self.queue_wake.drain_chat(chat_id.clone()).await?;
        self.queue_page(chat_id).await
    }

    async fn record_decision(
        &self,
        session_id: &str,
        plan: &AppPlanDecisionPlan,
        action: AppPlanDecisionAction,
    ) -> Result<(), GatewayApplicationError> {
        let now = self.dependencies.identity_clock.now_iso();
        let subscribers = self.subscribers.clone();
        let session = session_id.to_owned();
        let plan_id = plan.id.clone();
        let status = plan.status.clone();
        let action = action.as_str().to_owned();
        self.storage
            .execute(move |db| {
                events::append(
                    db,
                    &subscribers,
                    "session.plan_decision",
                    None,
                    json!({
                        "session_id":session,
                        "plan_id":plan_id,
                        "action":action,
                        "status":status,
                    })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                    &now,
                )?;
                Ok(())
            })
            .await
            .map_err(app_error)
    }

    fn plan_document(&self, plan: AppPlanDecisionPlan) -> AppPlanDecisionDocument {
        let mut safe_id = String::with_capacity(plan.id.len());
        let mut in_replacement = false;
        for value in plan.id.chars() {
            if value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | '/' | '-') {
                safe_id.push(value);
                in_replacement = false;
            } else if !in_replacement {
                safe_id.push('-');
                in_replacement = true;
            }
        }
        AppPlanDecisionDocument {
            id: plan.id,
            kind: "plan",
            document_type: "plan",
            title: plan.title,
            status: plan.status,
            safe_path_label: format!("plans/{safe_id}.md"),
            markdown: plan.body,
            updated_at: self.dependencies.identity_clock.now_iso(),
        }
    }
}

impl AppPlanDecisionAction {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::Reject => "reject",
            Self::Instruct => "instruct",
        }
    }
}

fn public(status: u16, code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.into(),
        message: message.into(),
    }
}
