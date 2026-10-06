//! Cross-conversation management; grant identity and enforcement stay unchanged.
use super::contracts::{AuthorityResult, ConversationPermission, PrincipalAuthority};
use std::collections::{BTreeSet, HashMap};

impl PrincipalAuthority {
    /// Read grants once and restore exact targets once per distinct owner using the owner index.
    pub async fn list_all_permissions(&self) -> AuthorityResult<Vec<ConversationPermission>> {
        let collation = self.collation.clone();
        self.in_lane(move |repo| {
            let profile = std::env::var("BUTLER_E2E_STORAGE_METRICS").as_deref() == Ok("1");
            let start = std::time::Instant::now();
            let mut grants = repo.list_all_permissions()?;
            let listed = start.elapsed();
            let mut query_us = 0;
            let mut restore_us = 0;
            let owners: BTreeSet<_> = grants.iter().map(|g| g.owner_session_id.clone()).collect();
            let mut sources = HashMap::with_capacity(grants.len());
            let mut prefixes = HashMap::new();
            for owner in owners {
                let step = std::time::Instant::now();
                let records = repo.permission_projection_records(&owner)?;
                query_us += step.elapsed().as_micros();
                let step = std::time::Instant::now();
                for record in records {
                    let source = super::permission::for_source(record, &collation, &mut prefixes)?;
                    sources.insert(source.grant_ref.clone(), source);
                }
                restore_us += step.elapsed().as_micros();
            }
            for grant in &mut grants {
                if let Some(source) = sources.remove(&grant.grant_ref) {
                    grant.capability = source.capability;
                    grant.target = source.target;
                    grant.cwd = source.cwd;
                }
            }
            if profile { eprintln!("approvals-profile list_us={} query_us={query_us} restore_us={restore_us} total_us={}", listed.as_micros(), start.elapsed().as_micros()); }
            Ok(grants)
        })
        .await
    }

    /// A grouped settings row revokes atomically in the existing authority lane.
    pub async fn revoke_permissions(&self, grants: Vec<(String, String)>) -> AuthorityResult<()> {
        let clock = self.clock.clone();
        self.in_lane(move |repo| repo.revoke_permissions(&grants, &clock()))
            .await
    }
}
