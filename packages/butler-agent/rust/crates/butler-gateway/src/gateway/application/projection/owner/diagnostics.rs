//! Bounded failure classification, without payloads, paths or credentials.
use crate::gateway::GatewayApplicationError;
use crate::gateway::application::storage::AppStorageError;

pub(super) fn code(error: &GatewayApplicationError) -> String {
    let source = match error {
        GatewayApplicationError::Public { code, source, .. } => {
            if source.is_none() {
                return code.clone();
            }
            source
        }
        GatewayApplicationError::Internal { source } => source,
    };
    let Some(storage) = source
        .as_ref()
        .and_then(|source| source.downcast_ref::<AppStorageError>())
    else {
        return "internal_gateway_error".into();
    };
    if let AppStorageError::Sqlite { source } = storage
        && let rusqlite::Error::SqliteFailure(sqlite, _) = source.as_ref()
    {
        return format!("{} ({})", storage.code(), sqlite.extended_code);
    }
    storage.code().into()
}
