use super::*;

#[derive(Clone, Debug)]
pub struct ArtifactMaterializationRequest {
    pub allowed_roots: Vec<PathBuf>,
    pub candidates: Vec<ArtifactFileCandidate>,
    pub existing_content_keys: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct ArtifactFileCandidate {
    pub candidate_paths: Vec<PathBuf>,
    pub name: String,
    pub mime_type: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterializedResponderFile {
    pub id: String,
    pub kind: String,
    pub mime_type: String,
    pub safe_name: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub storage_name: String,
    pub created_at: String,
}
