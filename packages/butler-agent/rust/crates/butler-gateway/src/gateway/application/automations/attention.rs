//! Attention from an unattended schedule run (D8): the run skipped a step
//! that needs the user's permission. The run and its schedule record the
//! reason, and subscribers (the App's run badge and notification) hear it.

use rusqlite::params;

use super::{AutomationRunSummary, dispatch::run_event, records, store::publish};
use crate::gateway::application::{
    AppApplication, AppStorageError, GatewayApplicationError, app_error, public,
};

/// The only attention codes a run may report.
const CODES: &[&str] = &[
    "schedule_permission_required",
    "schedule_signin_off",
    "schedule_payment_off",
];

impl AppApplication {
    pub(crate) async fn automation_run_attention_owned(
        &self,
        automation_id: String,
        run_id: String,
        code: String,
        tainted: bool,
        action: Option<serde_json::Value>,
    ) -> Result<AutomationRunSummary, GatewayApplicationError> {
        if !CODES.contains(&code.as_str()) {
            return Err(public(
                400,
                "automation_attention_invalid",
                "Unknown schedule attention code.",
            ));
        }
        let gate = self.initiated_gate().await?;
        let language = gate.language;
        let now = self.dependencies.identity_clock.now_iso();
        let subscribers = self.subscribers.clone();
        let result = self.storage
            .execute(move |db| {
                let existing = records::run(db, &run_id)?;
                if existing.automation_id != automation_id {
                    return Err(records::not_found());
                }
                if let Some(action) = action {
                    super::super::initiated::enqueue_attention(db, &automation_id, &run_id, &action, &language, &now)?;
                }
                if existing.safe_error_code.is_some() {
                    return Ok(existing);
                }
                let changed = db
                    .execute(
                        "UPDATE app_automation_runs SET safe_error_code=?1 WHERE id=?2 AND automation_id=?3",
                        params![code, run_id, automation_id],
                    )
                    .map_err(AppStorageError::sqlite)?;
                if changed == 0 {
                    return Err(AppStorageError::new(
                        crate::gateway::application::storage::AppStorageCode::AutomationNotFound,
                        "Schedule run not found.",
                    ));
                }
                db.execute(
                    "UPDATE app_automations SET last_safe_error_code=?1,updated_at=?2 WHERE id=?3",
                    params![code, now, automation_id],
                )
                .map_err(AppStorageError::sqlite)?;
                let run = records::run(db, &run_id)?;
                let mut event = run_event(&run);
                event["tainted"] = serde_json::Value::Bool(tainted);
                publish(db, &subscribers, "automation.run", &event, &now)?;
                Ok(run)
            })
            .await
            .map_err(app_error);
        self.automation_wake.notify_one();
        result
    }
}
