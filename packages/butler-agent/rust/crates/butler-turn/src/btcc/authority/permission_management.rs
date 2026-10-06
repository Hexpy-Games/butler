//! Cross-conversation management; grant identity and enforcement stay unchanged.
use super::contracts::{
    AuthorityError, AuthorityResult, ConversationPermission, PermissionTarget, PrincipalAuthority,
};
use std::collections::{BTreeSet, HashMap};

// Cached projections are keyed by every source field, never by owner alone.
#[derive(Default)]
pub(super) struct PermissionCache {
    targets: HashMap<[String; 5], PermissionTarget>,
}

impl PrincipalAuthority {
    /// Read active grants and their indexed sources in two passes, without historical table reads.
    pub async fn list_all_permissions(&self) -> AuthorityResult<Vec<ConversationPermission>> {
        let collation = self.collation.clone();
        let cache = self.permission_targets.clone();
        self.in_lane(move |repo| {
            let profile = std::env::var("BUTLER_E2E_STORAGE_METRICS").as_deref() == Ok("1");
            let usage = profile.then(|| butler_platform::process_control::sample_usage(std::process::id()).ok().flatten()).flatten();
            let start = std::time::Instant::now();
            let mut grants = repo.list_all_permissions()?;
            let listed = start.elapsed();
            project_targets(
                repo,
                &collation,
                &mut *cache
                    .lock()
                    .map_err(|_| AuthorityError::policy("permission_cache_unavailable"))?,
                &mut grants,
            )?;
            if profile {
                if let (Some(before), Some(after)) = (usage, butler_platform::process_control::sample_usage(std::process::id()).ok().flatten()) {
                    eprintln!("approvals-profile cpu_user_delta={:?} cpu_system_delta={:?} read_bytes_delta={}",
                        after.cpu_user_time.zip(before.cpu_user_time).map(|(a,b)| a.saturating_sub(b)),
                        after.cpu_system_time.zip(before.cpu_system_time).map(|(a,b)| a.saturating_sub(b)),
                        after.read_bytes.saturating_sub(before.read_bytes));
                }
                eprintln!("approvals-profile list_us={} projection_us={} total_us={}",
                    listed.as_micros(), start.elapsed().saturating_sub(listed).as_micros(), start.elapsed().as_micros());
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

fn project_targets(
    repo: &mut dyn super::contracts::AuthorityRepository,
    collation: &butler_core::locale::LocaleCollation,
    cache: &mut PermissionCache,
    grants: &mut [ConversationPermission],
) -> AuthorityResult<()> {
    let active: std::collections::HashSet<_> =
        grants.iter().map(|grant| grant.grant_ref.clone()).collect();
    let owners: Vec<_> = grants
        .iter()
        .map(|g| g.owner_session_id.as_str())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let mut sources = HashMap::with_capacity(grants.len());
    let mut current = std::collections::HashSet::new();
    let mut prefixes = HashMap::new();
    let comparisons = Default::default();
    repo.permission_projection_records(&owners, &mut |record| {
        let key = [
            record.owner,
            record.workspace,
            record.capability,
            record.target,
            record.input_json,
        ]
        .map(str::to_owned);
        let mut source = if let Some(source) = cache.targets.get(&key) {
            source.clone()
        } else {
            let source =
                super::permission::for_source(&record, collation, &mut prefixes, &comparisons)?;
            if active.contains(&source.grant_ref) {
                cache.targets.insert(key.clone(), source.clone());
            }
            source
        };
        if active.contains(&source.grant_ref) {
            current.insert(key);
        }
        sources.insert(std::mem::take(&mut source.grant_ref), source);
        Ok(())
    })?;
    cache.targets.retain(|key, _| current.contains(key));
    for grant in grants.iter_mut() {
        if let Some(source) = sources.remove(&grant.grant_ref) {
            grant.capability = source.capability;
            grant.target = source.target;
            grant.cwd = source.cwd;
        }
    }
    Ok(())
}
