use super::{AccessDecision, GrantUse, TargetScope};
use crate::btcc::authority::approval::command_words::{
    normalize_prefix, program, read_only, segment_prefix, segments,
};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuleEffect {
    Allow,
    Deny,
}

pub struct CommandRule {
    pub effect: RuleEffect,
    pub prefix: Vec<String>,
}

#[derive(Default)]
pub struct PermissionRules {
    pub commands: Vec<CommandRule>,
    pub folders: Vec<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct PermissionRuleRow {
    pub rule_id: String,
    pub effect: &'static str,
    pub kind: &'static str,
    pub pattern: String,
    pub owner_session_id: Option<String>,
    pub created_at: String,
}

impl PermissionRuleRow {
    pub fn new(
        effect: &'static str,
        kind: &'static str,
        pattern: String,
        owner_session_id: Option<String>,
        created_at: String,
    ) -> Self {
        let owner = owner_session_id.as_deref().unwrap_or_default();
        let hash = crate::btcc::identity::digest(&format!(
            "{effect}\0{kind}\0{pattern}\0{owner}\0{created_at}"
        ));
        Self {
            rule_id: format!("rule-{}", &hash[..32]),
            effect,
            kind,
            pattern,
            owner_session_id,
            created_at,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuleVerdict {
    Deny,
    Allow,
    NoRule,
}

pub fn rule_verdict(command: &str, rules: &[CommandRule]) -> RuleVerdict {
    let command = butler_platform::command_sandbox::path_script(command);
    if rules.is_empty() {
        return RuleVerdict::NoRule;
    }
    let denies = |words: Vec<String>| {
        let mut words = words;
        if let Some(first) = words.first_mut() {
            *first = program(first);
        }
        rules
            .iter()
            .any(|rule| rule.effect == RuleEffect::Deny && words.starts_with(&rule.prefix))
    };
    let Some(parsed) = segments(command) else {
        return if command.split(['|', '&', ';', '\n']).any(|segment| {
            denies(
                segment
                    .split([' ', '\t'])
                    .filter(|word| !word.is_empty())
                    .map(|word| word.replace(['\'', '"'], ""))
                    .collect(),
            )
        }) {
            RuleVerdict::Deny
        } else {
            RuleVerdict::NoRule
        };
    };
    if parsed
        .iter()
        .any(|words| denies(words.iter().map(|word| word.text.clone()).collect()))
    {
        return RuleVerdict::Deny;
    }
    let mut matched = false;
    for (index, words) in parsed.into_iter().enumerate() {
        if !read_only(&words, index == 0) {
            let Some(prefix) = segment_prefix(&words) else {
                return RuleVerdict::NoRule;
            };
            if !rules
                .iter()
                .any(|rule| rule.effect == RuleEffect::Allow && rule.prefix == prefix)
            {
                return RuleVerdict::NoRule;
            }
            matched = true;
        }
    }
    if matched {
        RuleVerdict::Allow
    } else {
        RuleVerdict::NoRule
    }
}

pub fn apply_allow(
    decision: AccessDecision,
    verdict: RuleVerdict,
    scope: TargetScope,
) -> AccessDecision {
    let in_scope = matches!(
        scope,
        TargetScope::ProjectFolder | TargetScope::AllowedFolder
    );
    if verdict == RuleVerdict::Allow && in_scope && decision == AccessDecision::Ask(GrantUse::Honor)
    {
        AccessDecision::Allow
    } else {
        decision
    }
}

pub fn proposal_shape(
    effect: &str,
    kind: &str,
    pattern: &str,
    scope: &str,
) -> Result<Option<String>, &'static str> {
    match kind {
        "command_prefix" => normalize_prefix(pattern)
            .map(|prefix| Some(prefix.join(" ")))
            .ok_or("prefix_invalid"),
        "folder" if effect == "allow" && scope == "always" => Ok(None),
        "folder" => Err("folder_allow_always_only"),
        _ => Err("prefix_invalid"),
    }
}

#[cfg(test)]
pub(super) mod tests;
