use super::{AGENT_NAME_HINT, Error, RESOURCE, SCOPES, SignInAttempt, SignInKind};

pub fn url(attempt: &SignInAttempt, redirect: &str) -> Result<url::Url, Error> {
    let mut url = url::Url::parse(&attempt.discovery.authorization_endpoint)
        .map_err(|_| "oauth_discovery_unavailable")?;
    url.query_pairs_mut().clear().extend_pairs([
        ("client_id", attempt.client_id.as_str()),
        ("ext_agent_host_id", &attempt.host_id),
        ("response_type", "code"),
        ("redirect_uri", redirect),
        ("scope", SCOPES),
        ("resource", RESOURCE),
        ("state", &attempt.state),
        ("nonce", &attempt.nonce),
        (
            "code_challenge",
            &super::super::pkce_challenge(&attempt.verifier),
        ),
        ("code_challenge_method", "S256"),
    ]);
    if attempt.new_registration {
        url.query_pairs_mut()
            .append_pair("agent_name_hint", AGENT_NAME_HINT);
    } else if let Some(email) = attempt.registration["email"].as_str() {
        url.query_pairs_mut().append_pair("login_hint", email);
    }
    if attempt.kind == SignInKind::EnablePlan {
        url.query_pairs_mut().append_pair("prompt", "consent");
    }
    Ok(url)
}
