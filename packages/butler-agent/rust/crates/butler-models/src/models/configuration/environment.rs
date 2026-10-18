use std::{collections::HashMap, path::PathBuf};

use super::ModelConfigurationEnvironment;

pub(super) fn merge_private_auth_environment(
    target: &mut ModelConfigurationEnvironment,
    private: &HashMap<String, String>,
) {
    fn string(target: &mut Option<String>, private: &HashMap<String, String>, key: &str) {
        if target.as_deref().is_none_or(str::is_empty) {
            *target = private.get(key).cloned().filter(|value| !value.is_empty());
        }
    }
    fn path(target: &mut Option<PathBuf>, private: &HashMap<String, String>, key: &str) {
        if target
            .as_ref()
            .is_none_or(|value| value.as_os_str().is_empty())
        {
            *target = private
                .get(key)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from);
        }
    }

    string(&mut target.openai_api_key, private, "OPENAI_API_KEY");
    path(
        &mut target.chatgpt_auth_dir,
        private,
        "BUTLER_CHATGPT_AUTH_DIR",
    );
}
