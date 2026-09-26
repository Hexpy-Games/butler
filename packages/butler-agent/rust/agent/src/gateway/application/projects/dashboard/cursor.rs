use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use super::contracts::invalid_cursor;

pub(super) fn encode<T: Serialize>(cursor: &T) -> Result<String, serde_json::Error> {
    serde_json::to_vec(cursor).map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
}

pub(super) fn decode<T: DeserializeOwned>(
    value: &str,
) -> Result<T, crate::gateway::GatewayApplicationError> {
    if value.len() > 2048 {
        return Err(invalid_cursor());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| invalid_cursor())?;
    serde_json::from_slice(&bytes).map_err(|_| invalid_cursor())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct RevisionOffsetCursor {
    pub revision: String,
    pub offset: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct ArtifactCursor {
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub rowid: u64,
    #[serde(rename = "fileId")]
    pub file_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct HistoryCursor {
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub revision: String,
    pub rowid: u64,
    pub at: String,
    pub id: String,
}
