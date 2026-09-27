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
    string(&mut target.codex_base_url, private, "BUTLER_CODEX_BASE_URL");
    string(
        &mut target.oauth_originator,
        private,
        "BUTLER_CODEX_OAUTH_ORIGINATOR",
    );
    string(
        &mut target.codex_user_agent,
        private,
        "BUTLER_CODEX_USER_AGENT",
    );
    if target.oauth_originator.is_none() {
        string(
            &mut target.oauth_originator,
            private,
            "BUTLER_OPENAI_OAUTH_ORIGINATOR",
        );
    }
    if target.oauth_authorize_url.is_none() {
        string(
            &mut target.oauth_authorize_url,
            private,
            "BUTLER_CODEX_OAUTH_AUTHORIZE_URL",
        );
        if target.oauth_authorize_url.is_none() {
            string(
                &mut target.oauth_authorize_url,
                private,
                "BUTLER_OPENAI_OAUTH_AUTHORIZE_URL",
            );
        }
    }
    if target.oauth_token_url.is_none() {
        string(
            &mut target.oauth_token_url,
            private,
            "BUTLER_CODEX_OAUTH_TOKEN_URL",
        );
        if target.oauth_token_url.is_none() {
            string(
                &mut target.oauth_token_url,
                private,
                "BUTLER_OPENAI_OAUTH_TOKEN_URL",
            );
        }
    }
    if target.oauth_client_id.is_none() {
        string(
            &mut target.oauth_client_id,
            private,
            "BUTLER_CODEX_OAUTH_CLIENT_ID",
        );
        if target.oauth_client_id.is_none() {
            string(
                &mut target.oauth_client_id,
                private,
                "BUTLER_OPENAI_OAUTH_CLIENT_ID",
            );
        }
    }
    if target.oauth_scope.is_none() {
        string(&mut target.oauth_scope, private, "BUTLER_CODEX_OAUTH_SCOPE");
        if target.oauth_scope.is_none() {
            string(
                &mut target.oauth_scope,
                private,
                "BUTLER_OPENAI_OAUTH_SCOPE",
            );
        }
    }
    path(
        &mut target.butler_codex_auth_profile,
        private,
        "BUTLER_CODEX_AUTH_PROFILE",
    );
    path(
        &mut target.butler_openai_auth_profile,
        private,
        "BUTLER_OPENAI_AUTH_PROFILE",
    );
    path(&mut target.codex_auth_json, private, "CODEX_AUTH_JSON");
    path(&mut target.codex_home, private, "CODEX_HOME");
}
