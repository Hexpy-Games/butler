mod authority;
mod contracts;
mod query;

pub(crate) use contracts::*;

use std::sync::Arc;

use super::{BtccStorage, StorageResult};

#[derive(Clone)]
pub(crate) struct OperationResultRepository {
    storage: BtccStorage,
    authority: Option<Arc<dyn ExactProjectWorkResultAuthority>>,
    project_factory: Option<Arc<dyn ProjectWorkResultAuthorityFactory>>,
}

impl OperationResultRepository {
    #[cfg(test)]
    pub(crate) fn new(
        storage: BtccStorage,
        authority: Option<Arc<dyn ExactProjectWorkResultAuthority>>,
    ) -> Self {
        Self {
            storage,
            authority,
            project_factory: None,
        }
    }

    pub(crate) fn with_project_authority_factory(
        storage: BtccStorage,
        project_factory: Arc<dyn ProjectWorkResultAuthorityFactory>,
    ) -> Self {
        Self {
            storage,
            authority: None,
            project_factory: Some(project_factory),
        }
    }

    pub(crate) async fn discover(
        &self,
        input: OperationResultDiscoveryInput,
    ) -> StorageResult<OperationResultDiscovery> {
        self.storage
            .execute(move |db| query::discover(db, &input))
            .await
    }

    pub(crate) async fn resolve_result_reference(
        &self,
        input: OperationResultReferenceInput,
    ) -> StorageResult<OperationResultReference> {
        let authority = if let Some(factory) = &self.project_factory {
            let location = self
                .storage
                .execute({
                    let input = input.clone();
                    move |db| authority::for_reference(db, &input)
                })
                .await?;
            match location {
                Some(location) => Some(factory.prepare(location).await?),
                None => None,
            }
        } else {
            self.authority.clone()
        };
        self.storage
            .execute(move |db| query::resolve(db, authority.as_deref(), &input))
            .await
    }

    pub(crate) async fn read_exact_result_range(
        &self,
        input: ExactResultRangeInput,
    ) -> StorageResult<ExactResultRange> {
        let authority = if let Some(factory) = &self.project_factory {
            let location = self
                .storage
                .execute({
                    let input = input.clone();
                    move |db| authority::for_range(db, &input)
                })
                .await?;
            match location {
                Some(location) => Some(factory.prepare(location).await?),
                None => None,
            }
        } else {
            self.authority.clone()
        };
        self.storage
            .execute(move |db| query::read_exact(db, authority.as_deref(), &input))
            .await
    }
}

#[cfg(test)]
mod tests;
