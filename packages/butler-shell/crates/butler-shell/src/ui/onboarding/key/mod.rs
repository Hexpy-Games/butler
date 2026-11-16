//! An API key, or Other (`FirstRunKeyForm`, `useKeyVerification`, `FirstRunCustomServer`,
//! `FirstRunModelPicker`).
//!
//! [`KeyForm`] is one API key field: checked with the service as soon as it is pasted
//! (`POST /setup/credentials/verify`), then saved (`POST /credentials`, named by the Agent). A
//! newer input always wins over an older answer, and a failed key stays in the field.
mod copy;
mod custom;
mod screen;

use std::time::Duration;

use butler_shell_client::Error;
use gpui::{Context, EventEmitter, SharedString, Task, Window};
use serde::Deserialize;
use serde_json::json;

use super::providers::{self, CardId};
use crate::ui::settings::state::fetch;

pub(crate) use custom::{CustomEvent, CustomServer, custom_screen};
pub(crate) use screen::key_screen;

/// `KEY_VERIFY_DEBOUNCE_MS`: the pause after the last keystroke or paste before checking.
const VERIFY_DEBOUNCE: Duration = Duration::from_millis(400);
/// `MIN_KEY_LENGTH`: shorter input is still being typed, not a key.
const MIN_KEY_LENGTH: usize = 8;

/// The key was verified and saved as a credential.
pub(crate) enum KeyEvent {
    Saved {
        card: CardId,
        credential_id: SharedString,
    },
}

/// `KeyCheckFailure`, in the order of `Words::key_errors`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Failure {
    Invalid,
    NoAccess,
    Network,
    RateLimited,
    Unavailable,
    Unsupported,
    BadRequest,
    SaveFailed,
}

impl Failure {
    /// `RETRYABLE_KEY_FAILURES`: a second try can fix it without a new key.
    pub(super) fn retryable(self) -> bool {
        matches!(
            self,
            Self::Network | Self::RateLimited | Self::Unavailable | Self::SaveFailed
        )
    }
}

/// `KeyStatus`; `Saved`: stored, but the service has no model list to check the key against.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Status {
    Idle,
    Checking,
    Valid,
    Saved,
    Failed(Failure),
}

/// The decoded `POST /setup/credentials/verify` answer.
#[derive(Deserialize)]
struct Verified {
    verified: Option<bool>,
}

/// The decoded `POST /credentials` answer.
#[derive(Deserialize)]
struct Saved {
    credential: SavedCredential,
}

#[derive(Deserialize)]
struct SavedCredential {
    id: String,
}

/// The key form for one card.
pub(crate) struct KeyForm {
    pub(super) card: CardId,
    pub(super) value: SharedString,
    pub(super) status: Status,
    sequence: u64,
    debounce: Option<Task<()>>,
    /// The field takes the focus on its next render: after a failure (on open, the card's title
    /// takes it).
    focus: bool,
}

impl EventEmitter<KeyEvent> for KeyForm {}

impl KeyForm {
    pub(crate) fn new(card: CardId, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let _ = (window, cx);
        Self {
            card,
            value: SharedString::default(),
            status: Status::Idle,
            sequence: 0,
            debounce: None,
            focus: false,
        }
    }

    /// Whether the field is to be focused now; asking clears it.
    pub(super) fn take_focus(&mut self, _: &mut Context<Self>) -> bool {
        std::mem::take(&mut self.focus)
    }

    /// `change`: a new input cancels the pending check and schedules the next.
    pub(super) fn change(&mut self, text: &str, cx: &mut Context<Self>) {
        self.value = text.to_owned().into();
        self.status = Status::Idle;
        self.debounce = None;
        self.sequence += 1;
        let id = self.sequence;
        let key = text.trim().to_owned();
        if key.chars().count() >= MIN_KEY_LENGTH {
            self.debounce = Some(cx.spawn(async move |this, cx| {
                butler_ds::ui::motion::sleep(cx.background_executor(), VERIFY_DEBOUNCE).await;
                let _ = this.update(cx, |this, cx| this.check(id, &key, cx));
            }));
        }
        cx.notify();
    }

    /// `retry`: checks the same key again (after a network or service failure).
    pub(super) fn retry(&mut self, cx: &mut Context<Self>) {
        let key = self.value.trim().to_owned();
        if key.chars().count() < MIN_KEY_LENGTH {
            return;
        }
        self.debounce = None;
        self.sequence += 1;
        self.check(self.sequence, &key, cx);
    }

    fn provider_id(&self) -> &'static str {
        providers::card(self.card).provider_id.unwrap_or_default()
    }

    fn fail(&mut self, failure: Failure) {
        self.status = Status::Failed(failure);
        self.focus = true;
    }

    /// `check`, first half: verify the key with the service.
    fn check(&mut self, id: u64, key: &str, cx: &mut Context<Self>) {
        self.status = Status::Checking;
        cx.notify();
        let body = json!({ "provider_id": self.provider_id(), "api_key": key });
        fetch(
            cx,
            move |client| async move { client.verify_setup_credential(&body).await },
            move |this: &mut Self, result: Result<Option<Verified>, Error>, cx| {
                if id != this.sequence {
                    return;
                }
                match result {
                    Ok(answer) => {
                        let verified = answer.and_then(|answer| answer.verified) != Some(false);
                        this.save(id, verified, cx);
                    }
                    Err(error) => this.fail(key_failure(&error).unwrap_or(Failure::Unavailable)),
                }
            },
        );
    }

    /// `check`, second half: save the key (the same key again answers the existing credential).
    fn save(&mut self, id: u64, verified: bool, cx: &mut Context<Self>) {
        let body = json!({ "provider_id": self.provider_id(), "api_key": self.value.trim() });
        fetch(
            cx,
            move |client| async move { client.save_credential(&body).await },
            move |this: &mut Self, result: Result<Saved, Error>, cx| {
                if id != this.sequence {
                    return;
                }
                match result {
                    Ok(saved) => {
                        this.status = if verified {
                            Status::Valid
                        } else {
                            Status::Saved
                        };
                        cx.emit(KeyEvent::Saved {
                            card: this.card,
                            credential_id: saved.credential.id.into(),
                        });
                    }
                    Err(error) => this.fail(key_failure(&error).unwrap_or(Failure::SaveFailed)),
                }
            },
        );
    }
}

/// `KEY_CHECK_FAILURES`: the failure an API error code names.
fn key_failure(error: &Error) -> Option<Failure> {
    let Error::Http(_, Some(code)) = error else {
        return None;
    };
    match code.as_str() {
        "provider_auth_error" | "credential_key_invalid" | "invalid_key" => Some(Failure::Invalid),
        "provider_permission_error" | "provider_quota_exhausted" | "no_access" => {
            Some(Failure::NoAccess)
        }
        "provider_network_error" | "provider_timeout" | "network" => Some(Failure::Network),
        "rate_limited" => Some(Failure::RateLimited),
        "provider_unavailable" => Some(Failure::Unavailable),
        "unsupported_provider" => Some(Failure::Unsupported),
        "invalid_request" => Some(Failure::BadRequest),
        _ => None,
    }
}
