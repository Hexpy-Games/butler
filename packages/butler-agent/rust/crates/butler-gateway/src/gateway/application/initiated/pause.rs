//! Scheduled report attention is evaluated only at dispatch.
use super::super::automations::{records, timing};
use super::super::{
    AppApplication, AppStorageError, GatewayApplicationError, app_error, events, public,
};
use super::{gate::Gate, outbox};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::collections::HashSet;

const REPORT_PAUSE_UNOPENED_RUNS: usize = 3;

impl AppApplication {
    pub(in crate::gateway::application) async fn pause_unopened_report(
        &self,
        id: String,
        trigger: &str,
    ) -> Result<bool, GatewayApplicationError> {
        if trigger != "scheduled" {
            return Ok(false);
        }
        let gate = self.initiated_gate().await?;
        let clock = self.dependencies.identity_clock.clone();
        let subscribers = self.subscribers.clone();
        self.storage.execute(move |db| {
            let row = records::active(db, &id)?;
            if row.target_id != "general" { return Ok(false); }
            if row.state == "paused" {
                return db.query_row("SELECT report_paused_at IS NOT NULL FROM app_automations WHERE id=?1", [&id], |r| r.get(0)).map_err(AppStorageError::sqlite);
            }
            if row.state != "enabled" || !unopened(db, &id, &gate)? { return Ok(false); }
            let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
            tx.execute("UPDATE app_automations SET state='paused',report_paused_at=?1,updated_at=?1 WHERE id=?2", params![gate.now,id]).map_err(AppStorageError::sqlite)?;
            let schedule = row.schedule.as_ref().map_or_else(|| json!({"type":row.schedule_type,"interval_seconds":row.interval,"run_at":row.run_at}), |s| json!({"type":if s.kind=="weekly" && s.weekdays==[1,2,3,4,5] {"weekdays"} else {&s.kind},"time":s.time,"weekdays":s.weekdays,"tz":s.tz}));
            let text = if gate.language == "ko" {
                format!("‘{}’ 보고를 {REPORT_PAUSE_UNOPENED_RUNS}번 연속 안 열어보셔서 잠시 멈춰 뒀어요. 계속 받으실래요?", row.title)
            } else {
                format!("You haven't opened '{}' the last {REPORT_PAUSE_UNOPENED_RUNS} times, so I paused it. Keep it coming?", row.title)
            };
            let payload = json!({"automation_id":id,"automation_title":row.title,
                "panel":{"kind":"schedule_pause","automation_id":id,"state":"pending","title":row.title,
                "schedule":schedule,"unopened_count":REPORT_PAUSE_UNOPENED_RUNS}});
            outbox::enqueue(&tx, (&clock.new_uuid(), "general"), &format!("schedule-pause:{id}:{}",gate.now), "schedule_pause", &text, &payload, &gate.now)?;
            let event = events::append_unpublished(&tx,"automation.updated",None,super::super::service::map(&json!({"automation":records::summary(records::active(&tx,&id)?)}))?,&gate.now)?;
            tx.commit().map_err(AppStorageError::sqlite)?;
            events::publish(&subscribers,&event);
            Ok(true)
        }).await.map_err(app_error)
    }

    pub(in crate::gateway::application) async fn skip_unopened_queued(
        &self,
        run: String,
    ) -> Result<super::super::automations::AutomationRunSummary, GatewayApplicationError> {
        let now = self.dependencies.identity_clock.now_iso();
        let subscribers = self.subscribers.clone();
        self.storage.execute(move |db| {
            let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
            tx.execute("UPDATE app_automation_runs SET state='skipped_report_unopened',completed_at=?1 WHERE id=?2",params![now,run]).map_err(AppStorageError::sqlite)?;
            let run = records::run(&tx,&run)?;
            tx.execute("UPDATE app_automations SET last_run_state=?1,last_run_at=?2 WHERE id=?3",params![run.state,now,run.automation_id]).map_err(AppStorageError::sqlite)?;
            let event = events::append_unpublished(&tx,"automation.run",None,super::super::service::map(&json!({"automation_id":run.automation_id,"target_session_id":run.target_session_id,"state":run.state,"trigger":run.trigger,"scheduled_at":run.scheduled_at,"late":run.late}))?,&now)?;
            tx.commit().map_err(AppStorageError::sqlite)?;
            events::publish(&subscribers,&event);
            Ok(run)
        }).await.map_err(app_error)
    }

    pub(crate) async fn report_pause_owned(
        &self,
        id: String,
        decision: String,
    ) -> Result<Value, GatewayApplicationError> {
        let _decision = self.initiated_decisions.lock().await;
        if !matches!(decision.as_str(), "continue" | "stop") {
            return Err(public(400, "invalid_decision", "Invalid decision."));
        }
        let automation = id.clone();
        let pending = self.storage.read(move |db| {
            db.query_row("SELECT source_key,payload_json FROM app_initiated_messages WHERE source_key='schedule-pause:'||?1||':'||(SELECT report_paused_at FROM app_automations WHERE id=?1)", [&automation], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional().map_err(AppStorageError::sqlite)
        }).await.map_err(app_error)?;
        let Some((source, payload)) = pending else {
            return Err(public(
                409,
                "report_pause_conflict",
                "This suggestion was already handled.",
            ));
        };
        let mut payload: Value =
            serde_json::from_str(&payload).map_err(GatewayApplicationError::internal_from)?;
        if payload["panel"]["state"] != "pending" {
            return Err(public(
                409,
                "report_pause_conflict",
                "This suggestion was already handled.",
            ));
        }
        let continued = decision == "continue";
        payload["panel"]["state"] = json!(if continued { "continued" } else { "stopped" });
        let now = self.dependencies.identity_clock.now_iso();
        let subscribers = self.subscribers.clone();
        let result = self.storage.execute(move |db| {
            let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
            let row = records::active(&tx, &id)?;
            let next = if continued { Some(continued_next(&row, &now)?) } else { row.next };
            tx.execute("UPDATE app_automations SET state=?1,next_run_at=?2,updated_at=?3,report_count_since=CASE WHEN ?4 THEN ?3 ELSE report_count_since END,report_paused_at=CASE WHEN ?4 THEN NULL ELSE report_paused_at END WHERE id=?5",
                params![if continued {"enabled"} else {"paused"},next,now,continued,id]).map_err(AppStorageError::sqlite)?;
            let message_event = outbox::update_payload(&tx, &source, &payload, &now)?;
            let summary = serde_json::to_value(records::summary(records::active(&tx, &id)?)).map_err(outbox::json_error)?;
            let event = events::append_unpublished(&tx,"automation.updated",None,super::super::service::map(&json!({"automation":summary}))?,&now)?;
            tx.commit().map_err(AppStorageError::sqlite)?;
            if let Some(event) = message_event { events::publish(&subscribers, &event); }
            events::publish(&subscribers, &event);
            let mut result = summary;
            result["prompt_body"] = json!(row.prompt);
            Ok(result)
        }).await.map_err(app_error)?;
        self.automation_wake.notify_one();
        Ok(result)
    }
}

fn unopened(db: &Connection, id: &str, gate: &Gate) -> Result<bool, AppStorageError> {
    let read: i64 = db.query_row("SELECT COALESCE((SELECT read_rowid FROM app_session_reads WHERE chat_id='general'),(SELECT baseline_rowid FROM app_session_read_baseline),0)", [], |r| r.get(0)).map_err(AppStorageError::sqlite)?;
    let mut statement = db.prepare_cached(
        "SELECT
           (SELECT m.rowid FROM messages m
            WHERE m.turn_id=r.turn_id AND m.role='assistant' AND m.status='delivered'
            ORDER BY m.rowid DESC LIMIT 1),
           (SELECT m.created_at FROM messages m
            WHERE m.turn_id=r.turn_id AND m.role='assistant' AND m.status='delivered'
            ORDER BY m.rowid DESC LIMIT 1)
         FROM app_automation_runs r
         WHERE r.automation_id=?1 AND r.trigger='scheduled' AND r.state='succeeded'
           AND r.turn_id IS NOT NULL
           AND r.started_at>COALESCE((SELECT report_count_since FROM app_automations WHERE id=?1),'')
         ORDER BY r.rowid DESC LIMIT ?2"
    ).map_err(AppStorageError::sqlite)?;
    let rows = statement
        .query_map(params![id, REPORT_PAUSE_UNOPENED_RUNS], |r| {
            Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<String>>(1)?))
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    if rows.len() != REPORT_PAUSE_UNOPENED_RUNS
        || rows.iter().any(|(row, _)| row.is_none_or(|n| n <= read))
    {
        return Ok(false);
    }
    let days = rows
        .iter()
        .map(|(_, at)| {
            gate.local(
                at.as_deref()
                    .ok_or_else(super::super::automations::timing::invalid)?,
            )
            .map(|at| at.date())
        })
        .collect::<Result<HashSet<_>, _>>()?;
    Ok(days.len() >= REPORT_PAUSE_UNOPENED_RUNS)
}

fn continued_next(row: &records::AutomationRow, now: &str) -> Result<String, AppStorageError> {
    if let Some(rule) = &row.schedule {
        return timing::next(rule, now);
    }
    if row.schedule_type == "once" {
        return row.run_at.clone().ok_or_else(timing::invalid);
    }
    timing::interval_next(
        row.start_at
            .as_deref()
            .or(row.next.as_deref())
            .unwrap_or(now),
        row.interval,
        now,
        None,
    )
}
