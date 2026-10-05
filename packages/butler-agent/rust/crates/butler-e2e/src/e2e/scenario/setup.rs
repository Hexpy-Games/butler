//! Allocate independent scenario state with private or shared immutable binaries.
use super::{
    Access, Fixture, HarnessError, LaunchMode, Placeholders, Sandbox, Setup, Source, fixtures,
};

impl Setup {
    pub fn new(id: &str) -> Result<Self, HarnessError> {
        Ok(Self::from_sandbox(id, Sandbox::new(id)?))
    }

    /// Independent data/provider/home using a caller-owned immutable installation.
    pub fn with_installation(id: &str, installation: &Sandbox) -> Result<Self, HarnessError> {
        Ok(Self::from_sandbox(
            id,
            Sandbox::with_installation(id, installation)?,
        ))
    }

    fn from_sandbox(id: &str, sandbox: Sandbox) -> Self {
        let mut placeholders = Placeholders::default();
        placeholders.add("W", sandbox.workspace.display().to_string());
        placeholders.add("D", sandbox.data.display().to_string());
        placeholders.add("SANDBOX", sandbox.root.display().to_string());
        Self {
            id: id.to_owned(),
            sandbox,
            placeholders,
            fixture: Fixture::Ready,
            access: Access::FullAccess,
            source: Source::None,
            env: vec![("BUTLER_E2E_APP_NOW".into(), fixtures::FIXTURE_TIME.into())],
            model: None,
            stub_credential: true,
            record_into: None,
            launch_mode: LaunchMode::Harness,
            replay_only: false,
            extends: None,
            login_refresh: false,
        }
    }
}
