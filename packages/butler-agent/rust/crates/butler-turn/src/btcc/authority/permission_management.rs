//! Cross-conversation management; grant identity and enforcement stay unchanged.
use super::contracts::{
    AuthorityRepository, AuthorityResult, ConversationPermission, PrincipalAuthority,
};
use std::collections::{BTreeSet, HashMap};

impl PrincipalAuthority {
    /// Read active grants and their indexed sources in two passes, without historical table reads.
    pub async fn list_all_permissions(&self) -> AuthorityResult<Vec<ConversationPermission>> {
        let collation = self.collation.clone();
        let projections = self.permission_projections.clone();
        self.in_lane(move |repo| {
            let profile = std::env::var("BUTLER_E2E_STORAGE_METRICS").as_deref() == Ok("1");
            let usage = profile.then(|| butler_platform::process_control::sample_usage(std::process::id()).ok().flatten()).flatten();
            let start = std::time::Instant::now();
            let mut grants = repo.list_all_permissions()?;
            let listed = start.elapsed();
            let owners: Vec<_> = grants
                .iter()
                .map(|g| g.owner_session_id.as_str())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .map(str::to_owned)
                .collect();
            let step = std::time::Instant::now();
            project_permissions(repo, &owners, &collation, &mut grants, &mut projections.lock())?;
            let projection_us = step.elapsed().as_micros();
            if profile {
                if let (Some(before), Some(after)) = (usage, butler_platform::process_control::sample_usage(std::process::id()).ok().flatten()) {
                    eprintln!("approvals-profile cpu_user_delta={:?} cpu_system_delta={:?} read_bytes_delta={}",
                        after.cpu_user_time.zip(before.cpu_user_time).map(|(a,b)| a.saturating_sub(b)),
                        after.cpu_system_time.zip(before.cpu_system_time).map(|(a,b)| a.saturating_sub(b)),
                        after.read_bytes.saturating_sub(before.read_bytes));
                }
                eprintln!(
                    "approvals-profile list_us={} projection_us={projection_us} total_us={}",
                    listed.as_micros(),
                    start.elapsed().as_micros()
                );
            }
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

struct GrantProjection<'a> {
    capability: &'a mut String,
    target: &'a mut String,
    cwd: &'a mut Option<String>,
    latest: Option<(String, i64)>,
}

fn project_permissions(
    repo: &mut dyn AuthorityRepository,
    owners: &[String],
    collation: &butler_core::locale::LocaleCollation,
    grants: &mut [ConversationPermission],
    cache: &mut super::permission_cache::ProjectionCache,
) -> AuthorityResult<()> {
    // Borrow the output rows: no second projection map or removal pass.
    let mut by_ref: HashMap<_, _> = grants
        .iter_mut()
        .map(|grant| {
            (
                grant.grant_ref.as_str(),
                GrantProjection {
                    capability: &mut grant.capability,
                    target: &mut grant.target,
                    cwd: &mut grant.cwd,
                    latest: None,
                },
            )
        })
        .collect();
    let mut prefixes = HashMap::new();
    cache.begin();
    let result = repo.permission_projection_records(owners, &mut |record| {
        let source = cache.project(&record, collation, &mut prefixes)?;
        if let Some(grant) = by_ref.get_mut(source.grant_ref.as_str()) {
            let key = (record.created_at, record.rowid);
            // The covering index need not sort every source by rowid. Preserve
            // the old query's last source, including equal timestamps.
            if grant
                .latest
                .as_ref()
                .is_none_or(|(created, rowid)| key > (created.as_str(), *rowid))
            {
                *grant.capability = source.capability;
                *grant.target = source.target;
                *grant.cwd = source.cwd;
                grant.latest = Some((record.created_at.to_owned(), record.rowid));
            }
        }
        Ok(())
    });
    cache.finish();
    result
}
