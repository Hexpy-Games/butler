use super::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::locale::LocaleCollation;
use crate::models::{
    ModelCatalog, ModelConfiguration, ModelConfigurationClock, ModelConfigurationEnvironment,
};

struct FixedIdentity;
struct TestPruneMetrics(PathBuf);
impl PruneMetricObserver for TestPruneMetrics {
    fn observe_prune(
        &self,
        now_ms: f64,
        result: &PruneToolOutputResult,
        protected_count: usize,
    ) -> ContextResult<()> {
        let path = self.0.join("metrics/tool-output-prune.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let record = serde_json::json!({
            "schema":"butler.tool-output-prune.v1", "ts":now_ms,
            "scanned":result.scanned, "deleted":result.deleted,
            "bytesDeleted":result.bytes_deleted, "remainingBytes":result.remaining_bytes,
            "maxAgeMs":result.max_age_ms, "maxBytes":result.max_bytes,
            "protectedCount":protected_count, "rawTextStored":false,
        });
        std::fs::write(path, format!("{record}\n")).unwrap();
        Ok(())
    }
}
impl ToolOutputIdentity for FixedIdentity {
    fn now(&self) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_789_776_000)
    }
    fn uuid(&self) -> String {
        "01234567-89ab-4def-8123-456789abcdef".into()
    }
}
impl ModelConfigurationClock for FixedIdentity {
    fn now_iso(&self) -> String {
        "2026-09-19T00:00:00.000Z".into()
    }
    fn now_epoch_millis(&self) -> i64 {
        1_789_776_000_000
    }
}

struct Fixture {
    root: PathBuf,
    service: NativeToolOutput,
    owner: Arc<ContextBudgetOwner>,
}

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let root = std::env::temp_dir().join(format!(
            "butler-c5a-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let catalog = Arc::new(ModelCatalog::new().unwrap());
        let locale = Arc::new(LocaleCollation::new("en-US").unwrap());
        let configuration = Arc::new(
            ModelConfiguration::new(
                root.clone(),
                ModelConfigurationEnvironment::default(),
                Arc::new(FixedIdentity),
                Arc::clone(&catalog),
                locale,
                crate::models::provider_http_client().unwrap(),
                Arc::new(crate::configuration::ConfigurationWrites::new()),
            )
            .unwrap(),
        );
        let owner = Arc::new(ContextBudgetOwner::new(
            configuration,
            catalog,
            Default::default(),
        ));
        let service = NativeToolOutput::new(
            root.clone(),
            Arc::clone(&owner),
            Arc::new(FixedIdentity),
            Arc::new(TestPruneMetrics(root.clone())),
        );
        Self {
            root,
            service,
            owner,
        }
    }
    fn budget(&self, stdout: &str, retain_original: bool) -> BudgetToolOutputInput {
        BudgetToolOutputInput {
            result: ShellCommandResult {
                stdout: stdout.into(),
                stderr: String::new(),
                exit_code: Some(0),
                timed_out: false,
            },
            command: Some("printf".into()),
            cwd: Some(self.root.to_string_lossy().into_owned()),
            max_model_tokens: Some(200.0),
            output_mode: OutputModeInput::Present(serde_json::json!("full")),
            validation_suite: None,
            retain_original,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[path = "tests/budget.rs"]
mod budget_cases;
mod integration;
mod lifecycle;
#[path = "tests/reader.rs"]
mod reader_cases;
