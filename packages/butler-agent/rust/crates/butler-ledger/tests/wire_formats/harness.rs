//! A fresh Butler data root with one Project Ledger and a transcript of every
//! observed output, normalized for golden comparison.

use std::fmt::Debug;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use butler_core::locale::LocaleCollation;
use butler_ledger::project_ledger::{LedgerCommand, LedgerCommandRequest, ProjectLedger};
use butler_turn::btcc::ResolvedProjectWorkScope;

use super::golden::{Normalizer, tree};

pub(crate) const APP_PROJECT: &str = "app-demo";
pub(crate) const LEDGER_PROJECT: &str = "demo";

pub(crate) struct Harness {
    pub(crate) data: PathBuf,
    pub(crate) root: PathBuf,
    pub(crate) ledger: ProjectLedger,
    normalizer: Normalizer,
    transcript: String,
}

impl Harness {
    pub(crate) fn new(label: &str) -> Self {
        let data = std::env::temp_dir().join(format!(
            "butler-ledger-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&data).unwrap();
        let data = fs::canonicalize(&data).unwrap();
        let root = data.join("project-ledger/projects").join(LEDGER_PROJECT);
        let collation = Arc::new(LocaleCollation::new("en-US").unwrap());
        let ledger = ProjectLedger::with_collation(&data, 2, collation);
        Self {
            normalizer: Normalizer::new(&data),
            data,
            root,
            ledger,
            transcript: String::new(),
        }
    }

    pub(crate) fn scope(&self) -> ResolvedProjectWorkScope {
        ResolvedProjectWorkScope {
            app_project_id: APP_PROJECT.into(),
            ledger_project_id: LEDGER_PROJECT.into(),
            ledger_root: self.root.clone(),
        }
    }

    pub(crate) async fn init(&mut self) {
        let result = self
            .ledger
            .ensure_project_ledger(self.scope(), "Demo Project".into())
            .await;
        self.record_debug(
            "ensure_project_ledger",
            &result.map_err(|error| error.code().to_owned()),
        );
    }

    /// Runs one Ledger command and records its JSON envelope.
    pub(crate) async fn command(
        &mut self,
        step: &str,
        command: LedgerCommand,
        options: Value,
    ) -> Value {
        let result = self
            .ledger
            .execute_command(LedgerCommandRequest {
                project_root: self.root.clone(),
                command,
                options,
            })
            .await
            .unwrap();
        let step = self.normalizer.text(step);
        let text = self.normalizer.json(&result);
        let _ = write!(self.transcript, "=== {step}\n{text}\n");
        result
    }

    /// Records a Rust value through its Debug form.
    pub(crate) fn record_debug(&mut self, step: &str, value: &impl Debug) {
        let text = self.normalizer.text(&format!("=== {step}\n{value:#?}\n"));
        self.transcript.push_str(&text);
    }

    pub(crate) fn write(&self, relative: &str, contents: &str) {
        let path = self.root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    /// The transcript followed by every file under the Project Ledger root.
    pub(crate) fn finish(mut self) -> String {
        let files = tree(&self.data, &mut self.normalizer);
        format!("{}\n##### files\n{files}", self.transcript)
    }

    pub(crate) fn data(&self) -> &Path {
        &self.data
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.data).ok();
    }
}
