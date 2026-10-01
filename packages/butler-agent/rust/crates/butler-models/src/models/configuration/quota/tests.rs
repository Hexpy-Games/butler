//! Endpoint rules of the quota polls: where each provider's quota is read.

use super::*;

pub(crate) fn codex_usage_url_follows_the_configured_codex_base() {
    let url = |base: Option<&str>| codex_usage_url(base).map(|url| url.to_string());
    assert_eq!(
        url(None).as_deref(),
        Some("https://chatgpt.com/backend-api/wham/usage")
    );
    assert_eq!(
        url(Some("https://chatgpt.com/backend-api/")).as_deref(),
        Some("https://chatgpt.com/backend-api/wham/usage")
    );
    assert_eq!(
        url(Some("https://chatgpt.com/backend-api/codex/responses")).as_deref(),
        Some("https://chatgpt.com/backend-api/wham/usage")
    );
    assert_eq!(
        url(Some("http://127.0.0.1:4321")).as_deref(),
        Some("http://127.0.0.1:4321/wham/usage")
    );
    assert_eq!(url(Some("file:///tmp/x")), None);
}

pub(crate) fn zai_quota_url_comes_only_from_an_official_coding_plan_base() {
    let url = |base: &str, loopback: bool| zai_quota_url(base, loopback).map(|url| url.to_string());
    assert_eq!(
        url("https://api.z.ai/api/coding/paas/v4", false).as_deref(),
        Some("https://api.z.ai/api/monitor/usage/quota/limit")
    );
    assert_eq!(
        url("https://open.bigmodel.cn/api/coding/paas/v4/", false).as_deref(),
        Some("https://open.bigmodel.cn/api/monitor/usage/quota/limit")
    );
    // The pay-as-you-go base, other hosts, ports, schemes and decorations.
    for base in [
        "https://api.z.ai/api/paas/v4",
        "https://proxy.example.com/api/coding/paas/v4",
        "https://api.z.ai.example.com/api/coding/paas/v4",
        "https://api.z.ai:8443/api/coding/paas/v4",
        "http://api.z.ai/api/coding/paas/v4",
        "https://api.z.ai/api/coding/paas/v4?x=1",
        "https://user:pass@api.z.ai/api/coding/paas/v4",
        "not a url",
    ] {
        assert_eq!(url(base, false), None, "{base}");
    }
}

pub(crate) fn zai_quota_url_admits_loopback_only_from_the_environment() {
    let base = "http://127.0.0.1:4321/api/coding/paas/v4";
    assert_eq!(zai_quota_url(base, false), None);
    assert_eq!(
        zai_quota_url(base, true)
            .map(|url| url.to_string())
            .as_deref(),
        Some("http://127.0.0.1:4321/api/monitor/usage/quota/limit")
    );
    assert_eq!(
        zai_quota_url("http://10.0.0.2:4321/api/coding/paas/v4", true), // privacy-hygiene: allow-private-ip (non-loopback rejection test)
        None
    );
}

pub(crate) fn providers_without_a_quota_surface_are_not_offered() {
    assert_eq!(provider_quota_support("openai"), QuotaSupport::Polled);
    assert_eq!(provider_quota_support("zai"), QuotaSupport::Polled);
    assert_eq!(
        provider_quota_support("zai-api"),
        QuotaSupport::NotOffered(QuotaBilling::Api)
    );
    assert_eq!(
        provider_quota_support("opencode-go"),
        QuotaSupport::NotOffered(QuotaBilling::Subscription)
    );
    assert_eq!(
        provider_quota_support("local"),
        QuotaSupport::NotOffered(QuotaBilling::Unknown)
    );
}

/// Security boundary: a credential is sent only to its provider's own
/// quota endpoint, never to a host a user or config supplied.
// test-category: security
#[test]
fn quota_credentials_go_only_to_official_endpoints() {
    codex_usage_url_follows_the_configured_codex_base();
    zai_quota_url_comes_only_from_an_official_coding_plan_base();
    zai_quota_url_admits_loopback_only_from_the_environment();
    providers_without_a_quota_surface_are_not_offered();
}
