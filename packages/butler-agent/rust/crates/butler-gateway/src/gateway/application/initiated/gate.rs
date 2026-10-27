//! Shared ordering and quiet-hours gate; no persistent composing writes.
use super::super::automations::{CalendarSchedule, timing};
use super::super::{AppApplication, AppStorageError, GatewayApplicationError, app_error};
use chrono::{DateTime, Duration, Timelike};
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};

const COMPOSING_LEASE: i64 = 10;
pub(in crate::gateway::application) type Composing = Arc<Mutex<HashMap<String, String>>>;

pub(in crate::gateway::application) enum Hold {
    Free,
    Busy,
    Typing(String),
    Quiet(String),
}
impl Hold {
    pub(in crate::gateway::application) fn until(self) -> Option<String> {
        match self {
            Self::Typing(at) | Self::Quiet(at) => Some(at),
            _ => None,
        }
    }
}

pub(in crate::gateway::application) struct Gate {
    pub(super) now: String,
    pub(super) tz: String,
    pub(in crate::gateway::application) language: String,
    start: String,
    end: String,
    composing: Composing,
}
impl AppApplication {
    pub(in crate::gateway::application) async fn initiated_gate(
        &self,
    ) -> Result<Gate, GatewayApplicationError> {
        let settings = self.worker_profile_settings().await?;
        let facts = self.dependencies.settings_facts.snapshot()?;
        let tz = self
            .storage
            .read(move |db| super::super::settings::effective_timezone(db, &facts))
            .await
            .map_err(app_error)?;
        Ok(Gate {
            now: self.dependencies.identity_clock.now_iso(),
            tz,
            language: string(&settings, "language", "en"),
            start: string(&settings, "quiet_hours_start", "22:00"),
            end: string(&settings, "quiet_hours_end", "07:00"),
            composing: self.composing.clone(),
        })
    }

    pub(crate) async fn composing_owned(
        &self,
        chat: String,
    ) -> Result<Value, GatewayApplicationError> {
        let id = chat.clone();
        self.storage
            .read(move |db| {
                db.query_row("SELECT 1 FROM chats WHERE id=?1", [id], |_| Ok(()))
                    .optional()
                    .map_err(AppStorageError::sqlite)?
                    .ok_or_else(|| {
                        AppStorageError::new(
                            super::super::storage::AppStorageCode::SessionNotFound,
                            "Session not found.",
                        )
                    })
            })
            .await
            .map_err(app_error)?;
        let now = DateTime::parse_from_rfc3339(&self.dependencies.identity_clock.now_iso())
            .map_err(GatewayApplicationError::internal_from)?;
        self.composing.lock().insert(
            chat,
            (now + Duration::seconds(COMPOSING_LEASE))
                .with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        );
        self.automation_wake.notify_one();
        Ok(serde_json::json!({}))
    }

    pub(in crate::gateway::application) async fn automation_hold(
        &self,
        chat: String,
        trigger: &str,
    ) -> Result<Hold, GatewayApplicationError> {
        if trigger != "scheduled" || chat != "general" {
            return self
                .storage
                .read(move |db| {
                    Ok(
                        if super::super::queue_dispatcher::session_has_active_turn(db, &chat)? {
                            Hold::Busy
                        } else {
                            Hold::Free
                        },
                    )
                })
                .await
                .map_err(app_error);
        }
        let gate = self.initiated_gate().await?;
        self.storage
            .read(move |db| gate.hold(db, &chat, false))
            .await
            .map_err(app_error)
    }
}

impl Gate {
    pub(in crate::gateway::application) fn for_admission(
        db: &Connection,
        facts: &super::super::AppSettingsFacts,
        now: &str,
    ) -> Result<Self, AppStorageError> {
        let settings = &facts.native_settings["proactive_settings"];
        Ok(Self {
            now: now.into(),
            tz: super::super::settings::effective_timezone(db, facts)?,
            language: String::new(),
            start: string(settings, "quiet_hours_start", "22:00"),
            end: string(settings, "quiet_hours_end", "07:00"),
            composing: Default::default(),
        })
    }

    pub(super) fn hold(
        &self,
        db: &Connection,
        chat: &str,
        bypass: bool,
    ) -> Result<Hold, AppStorageError> {
        if super::super::queue_dispatcher::session_has_active_turn(db, chat)? {
            return Ok(Hold::Busy);
        }
        if chat != "general" {
            return Ok(Hold::Free);
        }
        let queued: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM session_queued_messages WHERE chat_id=?1 AND state IN ('queued','dispatching'))", [chat], |r| r.get(0)).map_err(AppStorageError::sqlite)?;
        if queued {
            return Ok(Hold::Busy);
        }
        self.work_hold(chat, bypass)
    }

    pub(super) fn work_hold(&self, chat: &str, bypass: bool) -> Result<Hold, AppStorageError> {
        if chat != "general" {
            return Ok(Hold::Free);
        }
        let lease = self.composing.lock().get(chat).cloned();
        if let Some(until) = lease.filter(|at| at.as_str() > self.now.as_str()) {
            return Ok(Hold::Typing(until));
        }
        if !bypass && self.quiet()? {
            return Ok(Hold::Quiet(timing::next(
                &CalendarSchedule {
                    kind: "daily".into(),
                    time: self.end.clone(),
                    weekdays: vec![],
                    tz: self.tz.clone(),
                },
                &self.now,
            )?));
        }
        Ok(Hold::Free)
    }

    pub(super) fn local(&self, at: &str) -> Result<chrono::NaiveDateTime, AppStorageError> {
        let now = DateTime::parse_from_rfc3339(at).map_err(|_| timing::invalid())?;
        let bytes =
            butler_platform::time_zone::zone_rules(&self.tz).map_err(|_| timing::invalid())?;
        let zone = tz::TimeZone::from_tz_data(&bytes).map_err(|_| timing::invalid())?;
        let offset = zone
            .find_local_time_type(now.timestamp())
            .map_err(|_| timing::invalid())?
            .ut_offset();
        now.naive_utc()
            .checked_add_signed(Duration::seconds(i64::from(offset)))
            .ok_or_else(timing::invalid)
    }

    pub(in crate::gateway::application) fn quiet(&self) -> Result<bool, AppStorageError> {
        let minute = self.local(&self.now)?.time();
        let current = format!("{:02}:{:02}", minute.hour(), minute.minute());
        Ok(if self.start < self.end {
            current >= self.start && current < self.end
        } else {
            current >= self.start || current < self.end
        })
    }
}
fn string(settings: &Value, key: &str, default: &str) -> String {
    settings[key].as_str().unwrap_or(default).to_owned()
}
