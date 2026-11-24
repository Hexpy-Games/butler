use super::contracts::{AuthorityResult, PrincipalAuthority};
use crate::btcc::{CommandRule, PermissionRuleRow, PermissionRules, RuleEffect};
use std::path::PathBuf;

impl PrincipalAuthority {
    pub async fn permission_rules(
        &self,
        owner: Option<String>,
    ) -> AuthorityResult<PermissionRules> {
        self.in_read(move |repo| {
            let mut rules = PermissionRules::default();
            for row in repo.permission_rules(Some(owner.as_deref()))? {
                if row.kind == "folder" {
                    rules.folders.push(PathBuf::from(row.pattern));
                } else {
                    rules.commands.push(CommandRule {
                        effect: if row.effect == "allow" {
                            RuleEffect::Allow
                        } else {
                            RuleEffect::Deny
                        },
                        prefix: row.pattern.split(' ').map(str::to_owned).collect(),
                    });
                }
            }
            Ok(rules)
        })
        .await
    }

    pub async fn list_permission_rules(&self) -> AuthorityResult<Vec<PermissionRuleRow>> {
        self.in_read(|repo| repo.permission_rules(None)).await
    }

    pub async fn add_permission_rule(&self, row: PermissionRuleRow) -> AuthorityResult<()> {
        self.in_lane(move |repo| repo.add_permission_rule(&row))
            .await
    }

    pub async fn revoke_permission_rule(&self, rule_id: String) -> AuthorityResult<()> {
        let clock = self.clock.clone();
        self.in_lane(move |repo| repo.revoke_permission_rule(&rule_id, &clock()))
            .await
    }
}
