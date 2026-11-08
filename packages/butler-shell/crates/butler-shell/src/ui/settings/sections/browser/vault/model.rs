//! What the agent answers (`signInsApi.ts`, `vaultApi.ts`) and the small formats the rows show.
//! Only the fields the sections read are declared; secrets are never in an answer except a
//! reveal's number.
use std::collections::HashMap;

use chrono::{Datelike as _, Local, Utc};
use serde::Deserialize;

use super::copy::{Unit, Words};

#[derive(Deserialize, Default)]
pub(super) struct SignInsView {
    #[serde(default)]
    pub(super) available: bool,
    #[serde(default)]
    pub(super) sites: Vec<SignInSite>,
}

#[derive(Deserialize)]
pub(super) struct SignInSite {
    pub(super) site: String,
    #[serde(default)]
    pub(super) entry: Option<SignInEntry>,
    #[serde(default)]
    pub(super) conversations: usize,
    #[serde(default)]
    pub(super) all_conversations: bool,
}

#[derive(Deserialize)]
pub(super) struct SignInEntry {
    pub(super) id: String,
    #[serde(default)]
    pub(super) username: String,
    #[serde(default)]
    pub(super) policy: String,
    #[serde(default)]
    pub(super) last_used_at: Option<String>,
}

#[derive(Deserialize, Default)]
pub(super) struct VaultView {
    #[serde(default)]
    pub(super) available: bool,
    #[serde(default)]
    pub(super) reveal_available: bool,
    #[serde(default)]
    pub(super) cards: Vec<VaultCard>,
    #[serde(default)]
    pub(super) profiles: Vec<VaultProfile>,
    #[serde(default)]
    pub(super) purchase_sites: Vec<String>,
}

#[derive(Deserialize)]
pub(super) struct VaultCard {
    pub(super) id: String,
    #[serde(default)]
    pub(super) nickname: String,
    #[serde(default)]
    pub(super) last4: String,
    #[serde(default)]
    pub(super) exp_month: i32,
    #[serde(default)]
    pub(super) exp_year: i32,
    #[serde(default)]
    pub(super) holder_name: String,
    #[serde(default)]
    pub(super) sites: Vec<String>,
}

#[derive(Deserialize)]
pub(super) struct VaultProfile {
    pub(super) id: String,
    #[serde(default)]
    pub(super) nickname: String,
    #[serde(default)]
    pub(super) details: HashMap<String, String>,
    #[serde(default)]
    pub(super) extras: Vec<String>,
    #[serde(default)]
    pub(super) sites: Vec<String>,
}

/// The answer of a reveal: the one place a number comes back.
#[derive(Deserialize)]
pub(super) struct Revealed {
    pub(super) number: String,
}

impl VaultCard {
    /// "MM/YY", as the row and the edit form show it.
    pub(super) fn expiry(&self) -> String {
        let year = self.exp_year.to_string();
        format!("{:02}/{}", self.exp_month, year.get(2..).unwrap_or(""))
    }

    pub(super) fn expired(&self) -> bool {
        let now = Local::now();
        let month = i32::try_from(now.month()).unwrap_or(0);
        self.exp_year < now.year() || self.exp_year == now.year() && self.exp_month < month
    }
}

/// `since`: an ISO time as a relative phrase, in minutes, hours or days.
pub(super) fn since(iso: &str, words: &Words) -> String {
    let seconds = chrono::DateTime::parse_from_rfc3339(iso)
        .map_or(0, |at| Utc::now().signed_duration_since(at).num_seconds())
        .max(0);
    let (count, unit) = if seconds < 3600 {
        (seconds / 60, Unit::Minute)
    } else if seconds < 86400 {
        (seconds / 3600, Unit::Hour)
    } else {
        (seconds / 86400, Unit::Day)
    };
    (words.ago)(count, unit)
}

/// `number.replace(/(\d{4})(?=\d)/g, "$1 ")`: a space after every four digits that a digit follows.
pub(super) fn grouped(number: &str) -> String {
    let mut out = String::with_capacity(number.len() + 4);
    let mut run = 0;
    let mut chars = number.chars().peekable();
    while let Some(c) = chars.next() {
        out.push(c);
        run = if c.is_ascii_digit() { run + 1 } else { 0 };
        if run == 4 {
            run = 0;
            if chars.peek().is_some_and(char::is_ascii_digit) {
                out.push(' ');
            }
        }
    }
    out
}
