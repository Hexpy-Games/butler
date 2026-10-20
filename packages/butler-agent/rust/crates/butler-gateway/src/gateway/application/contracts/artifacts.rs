use super::*;

#[derive(Clone, Debug)]
pub struct ArtifactMaterializationRequest {
    pub allowed_roots: Vec<PathBuf>,
    pub candidates: Vec<ArtifactFileCandidate>,
    pub existing_content_keys: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct ArtifactFileCandidate {
    pub title: Option<String>,
    pub source_label: Option<String>,
    pub deliverable: bool,
    pub candidate_paths: Vec<PathBuf>,
    pub name: String,
    pub mime_type: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterializedResponderFile {
    pub title: Option<String>,
    pub source_label: Option<String>,
    pub deliverable: bool,
    pub id: String,
    pub kind: String,
    pub mime_type: String,
    pub safe_name: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub storage_name: String,
    pub created_at: String,
}

/// Successful files and unavailable declarations are reported independently.
#[derive(Default)]
pub struct ArtifactMaterializationResult {
    pub files: Vec<MaterializedResponderFile>,
    pub unavailable: bool,
}

pub trait AppArtifactMaterializer: Send + Sync + 'static {
    fn materialize_with_limitations(
        &self,
        request: ArtifactMaterializationRequest,
    ) -> ApplicationFuture<ArtifactMaterializationResult> {
        let job = self.materialize(request);
        Box::pin(async move {
            Ok(ArtifactMaterializationResult {
                files: job.await?,
                unavailable: false,
            })
        })
    }

    fn materialize(
        &self,
        request: ArtifactMaterializationRequest,
    ) -> ApplicationFuture<Vec<MaterializedResponderFile>>;
}
