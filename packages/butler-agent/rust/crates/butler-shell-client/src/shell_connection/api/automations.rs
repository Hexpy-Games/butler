use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /automations?target_session_id
    pub async fn list_automations(&self, target_session_id: Option<&str>) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = target_session_id {
            query.push(("target_session_id", value.to_string()));
        }
        self.json(Method::GET, &["automations"], &query, None).await
    }
    /// POST /automations
    pub async fn create_automation(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["automations"], &[], Some(body))
            .await
    }
    /// GET /automations/{automation_id}
    pub async fn get_automation(&self, automation_id: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["automations", automation_id], &[], None)
            .await
    }
    /// PATCH /automations/{automation_id}
    pub async fn update_automation(
        &self,
        automation_id: &str,
        body: &Value,
    ) -> Result<Value, Error> {
        self.json(
            Method::PATCH,
            &["automations", automation_id],
            &[],
            Some(body),
        )
        .await
    }
    /// DELETE /automations/{automation_id}
    pub async fn delete_automation(&self, automation_id: &str) -> Result<Value, Error> {
        self.json(Method::DELETE, &["automations", automation_id], &[], None)
            .await
    }
    /// GET /automations/{automation_id}/runs
    pub async fn list_automation_runs(&self, automation_id: &str) -> Result<Value, Error> {
        self.json(
            Method::GET,
            &["automations", automation_id, "runs"],
            &[],
            None,
        )
        .await
    }
    /// POST /automations/dispatch-due
    pub async fn dispatch_due_automations(&self) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["automations", "dispatch-due"],
            &[],
            Some(&serde_json::json!({})),
        )
        .await
    }
    /// POST /automations/{automation_id}/run
    pub async fn run_automation(&self, automation_id: &str) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["automations", automation_id, "run"],
            &[],
            Some(&serde_json::json!({})),
        )
        .await
    }
    /// POST /automations/{automation_id}/pause
    pub async fn pause_automation(&self, automation_id: &str) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["automations", automation_id, "pause"],
            &[],
            Some(&serde_json::json!({})),
        )
        .await
    }
    /// POST /automations/{automation_id}/resume
    pub async fn resume_automation(&self, automation_id: &str) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["automations", automation_id, "resume"],
            &[],
            Some(&serde_json::json!({})),
        )
        .await
    }
    /// POST /automations/{automation_id}/report-pause
    pub async fn decide_report_pause(
        &self,
        automation_id: &str,
        body: &Value,
    ) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["automations", automation_id, "report-pause"],
            &[],
            Some(body),
        )
        .await
    }
}
