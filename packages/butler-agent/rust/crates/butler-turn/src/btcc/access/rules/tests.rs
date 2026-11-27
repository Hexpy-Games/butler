use super::*;
use crate::btcc::DenyReason;

pub(in crate::btcc) fn rule_verdict_table() {
    let rules = [
        CommandRule {
            effect: RuleEffect::Allow,
            prefix: vec!["git".into(), "add".into()],
        },
        CommandRule {
            effect: RuleEffect::Allow,
            prefix: vec!["git".into(), "status".into()],
        },
        CommandRule {
            effect: RuleEffect::Allow,
            prefix: vec!["rm".into()],
        },
        CommandRule {
            effect: RuleEffect::Deny,
            prefix: vec!["rm".into()],
        },
    ];
    for (line, expected) in [
        ("git add a && git status", RuleVerdict::Allow),
        ("git add a && git push", RuleVerdict::NoRule),
        ("rm x", RuleVerdict::Deny),
        ("/bin/rm x", RuleVerdict::Deny),
        ("\"rm\" x", RuleVerdict::Deny),
        ("x=$(y); rm -rf z", RuleVerdict::Deny),
        (r#"cmd /c "rm x""#, RuleVerdict::Deny),
        ("cmd /c cmd /c rm x", RuleVerdict::Deny),
        ("rm,x", RuleVerdict::Deny),
        (r"C:\Windows\System32\cmd.exe /c rm x", RuleVerdict::Deny),
        (
            r#""C:\Windows\System32\cmd.exe" /c rm x"#,
            RuleVerdict::Deny,
        ),
        ("r^m x", RuleVerdict::Deny),
        ("rm/x", RuleVerdict::Deny),
        ("cmd /c dir", RuleVerdict::NoRule),
        (r#"git commit -m "rm old""#, RuleVerdict::NoRule),
    ] {
        assert_eq!(rule_verdict(line, &rules), expected, "{line}");
    }
}

pub(in crate::btcc) fn allow_preserves_stronger_decisions() {
    for (decision, scope) in [
        (
            AccessDecision::Ask(GrantUse::Ignore),
            TargetScope::ProjectFolder,
        ),
        (
            AccessDecision::Deny(DenyReason::ReadOnly),
            TargetScope::AllowedFolder,
        ),
        (AccessDecision::Ask(GrantUse::Honor), TargetScope::Outside),
        (AccessDecision::Ask(GrantUse::Honor), TargetScope::Protected),
    ] {
        assert_eq!(apply_allow(decision, RuleVerdict::Allow, scope), decision);
    }
}

pub(in crate::btcc) fn proposal_shape_table() {
    for (effect, kind, pattern, scope, expected) in [
        (
            "deny",
            "folder",
            "~/work",
            "always",
            Err("folder_allow_always_only"),
        ),
        (
            "allow",
            "folder",
            "~/work",
            "conversation",
            Err("folder_allow_always_only"),
        ),
        (
            "allow",
            "command_prefix",
            "git",
            "always",
            Err("prefix_invalid"),
        ),
        (
            "allow",
            "command_prefix",
            "git status",
            "always",
            Ok(Some("git status".into())),
        ),
    ] {
        assert_eq!(proposal_shape(effect, kind, pattern, scope), expected);
    }
}
