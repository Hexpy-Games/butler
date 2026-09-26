use std::path::PathBuf;

use serde_json::Value;

use crate::gateway::GatewayApplicationError;

use super::{NativeAppPersonalization, errors::unsafe_personalization_path};

impl NativeAppPersonalization {
    pub(super) fn validate_read_destinations(&self) -> Result<(), GatewayApplicationError> {
        self.validate_paths(&[
            "butler.config.json",
            "personas/active.md",
            "eol.md",
            "personalization/profile.json",
            "cognition/profile/profile.sqlite",
        ])
    }

    pub(super) fn validate_write_destinations(
        &self,
        input: &Value,
        importing: bool,
    ) -> Result<(), GatewayApplicationError> {
        let mut paths = vec!["cognition/profile/profile.sqlite"];
        if importing {
            paths.extend([
                "cognition/profile/profile.sqlite",
                "cognition/consolidation/locks/consolidation.lock",
            ]);
        } else if let Some(object) = input.as_object() {
            if object.contains_key("persona") {
                paths.extend(["personas", "personas/active.md", "personalization/backups"]);
            }
            if object.contains_key("eol") {
                paths.extend(["eol.md", "personalization/backups"]);
            }
            if object.contains_key("profile") {
                paths.extend(["personalization/profile.json", "personalization"]);
            }
            if object.contains_key("response_language") {
                paths.push("butler.config.json");
            }
            if let Some(profiling) = object.get("profiling").and_then(Value::as_object)
                && (profiling.contains_key("extractor_model")
                    || profiling.contains_key("extractor_reasoning_effort"))
            {
                paths.push("butler.config.json");
            }
        }
        self.validate_paths(&paths)
    }

    pub(super) fn validated_root(&self) -> Result<PathBuf, GatewayApplicationError> {
        self.installation
            .validate_data_root(&self.data_root)
            .map_err(|_| unsafe_personalization_path())
    }

    fn validate_paths(&self, paths: &[&str]) -> Result<(), GatewayApplicationError> {
        let root = self.validated_root()?;
        for relative in paths {
            let resolved = self
                .installation
                .validate_data_root(&self.data_root.join(relative))
                .map_err(|_| unsafe_personalization_path())?;
            if !resolved.starts_with(&root) {
                return Err(unsafe_personalization_path());
            }
        }
        Ok(())
    }
}
