//! Allocate independent scenario state with private or shared immutable binaries.
use super::{
    Access, Fixture, HarnessError, LaunchMode, Placeholders, Sandbox, Setup, Source, fixtures,
};

impl Setup {
    /// A fixed App clock after the daily jobs have already run, for non-scheduler scenarios.
    pub fn clock_after_daily_jobs(self, at: &str) -> Result<Self, HarnessError> {
        fixtures::scheduler_ran_today(&self.sandbox.data, at)?;
        let path = self.sandbox.data.join("butler.config.json");
        let mut config: serde_json::Value = if path.exists() {
            serde_json::from_slice(&std::fs::read(&path)?)?
        } else {
            serde_json::json!({})
        };
        if config["user"].is_null() {
            config["user"] = serde_json::json!({});
        }
        config["user"]["timezone"] = fixtures::FIXTURE_TIMEZONE.into();
        std::fs::write(path, serde_json::to_vec_pretty(&config)?)?;
        Ok(self
            .env("TZ", fixtures::FIXTURE_TIMEZONE)
            .env("BUTLER_E2E_APP_NOW", at))
    }

    /// Removes a variable from child commands, including harness defaults.
    pub fn unset_env(mut self, key: &str) -> Self {
        self.unset_env.push(key.to_owned());
        self
    }

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
            record_budget: None,
            unset_env: Vec::new(),
        }
    }
}
