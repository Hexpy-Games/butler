use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::contracts::LedgerEffectError;

#[derive(Clone)]
pub(super) struct LedgerScope {
    pub root: PathBuf,
    pub project_id: String,
}

pub(super) fn resolve(project_root: &Path) -> Result<LedgerScope, LedgerEffectError> {
    if fs::symlink_metadata(project_root)
        .map_err(|_| LedgerEffectError::Uncertain)?
        .file_type()
        .is_symlink()
    {
        return Err(LedgerEffectError::Uncertain);
    }
    let root = fs::canonicalize(project_root).map_err(|_| LedgerEffectError::Uncertain)?;
    if fs::symlink_metadata(root.join("project.json"))
        .map_err(|_| LedgerEffectError::Uncertain)?
        .file_type()
        .is_symlink()
    {
        return Err(LedgerEffectError::Uncertain);
    }
    let bytes = fs::read(root.join("project.json")).map_err(|_| LedgerEffectError::Uncertain)?;
    let project: Value =
        serde_json::from_slice(&bytes).map_err(|_| LedgerEffectError::Uncertain)?;
    let id = project
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| valid_id(id))
        .ok_or(LedgerEffectError::Uncertain)?;
    if root.file_name().and_then(|name| name.to_str()) != Some(id) {
        return Err(LedgerEffectError::Uncertain);
    }
    Ok(LedgerScope {
        root,
        project_id: id.to_owned(),
    })
}

fn valid_id(id: &str) -> bool {
    crate::project_ledger::active_reference::safe_id(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialized_mixed_case_project_id_keeps_its_exact_ledger_root() {
        let data =
            std::env::temp_dir().join(format!("butler-ledger-scope-{}", uuid::Uuid::new_v4()));
        let root = data.join("project-ledger/projects/NanaChanAI");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("project.json"), r#"{"id":"NanaChanAI"}"#).unwrap();
        let scope = resolve(&root).unwrap();
        assert_eq!(scope.project_id, "NanaChanAI");
        assert_eq!(scope.root, root.canonicalize().unwrap());
        fs::remove_dir_all(data).unwrap();
    }
}
