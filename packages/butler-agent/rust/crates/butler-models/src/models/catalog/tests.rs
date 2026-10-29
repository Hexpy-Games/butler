//! Consistency pins over the bundled static catalog and the pure preset and
//! pricing rules.

use std::collections::BTreeSet;

use super::{lookup::provider_auth_methods, *};

mod browsing;
mod image_admission;
mod image_output;
mod presets;
mod provider_truth;

fn catalog() -> StaticCatalog {
    StaticCatalog::load().unwrap()
}

/// Providers the setup flow offers: every hosted provider in the catalog.
fn setup_providers(catalog: &StaticCatalog) -> BTreeSet<String> {
    catalog
        .models
        .iter()
        .map(|model| model.provider_id.clone())
        .filter(|provider| !provider_auth_methods(provider).is_empty())
        .collect()
}

// test-category: pure-logic
#[test]
fn every_static_model_has_a_tier_and_pricing() {
    image_output::assert_output_catalog();
    hosted_chat::assert_hosted_chat_catalog_presets_limits_and_wire_policy();
    for model in &catalog().models {
        if model.is_image_output() {
            model.image_output.as_ref().unwrap().validate().unwrap();
            assert!(model.tier.is_none());
            assert!(model.pricing.is_none());
            continue;
        }
        provider_truth::assert_lifecycle_suffix(model);
        assert!(model.tier.is_some(), "{} has no tier", model.model_ref);
        match &model.pricing {
            Some(ModelPricing::Published {
                base,
                prompt_tiers,
                valid_until,
                source_url,
                as_of,
                ..
            }) => {
                assert!(source_url.starts_with("https://"), "{}", model.model_ref);
                assert_eq!(as_of.len(), 10, "{}", model.model_ref);
                assert!(valid_until.as_ref().is_none_or(|day| day.len() == 10));
                assert_prices(&model.model_ref, base);
                let mut previous = 0;
                for tier in prompt_tiers {
                    assert!(tier.above_input_tokens > previous, "{}", model.model_ref);
                    previous = tier.above_input_tokens;
                    assert_prices(&model.model_ref, &tier.prices);
                }
            }
            Some(ModelPricing::Unknown {
                source_url, reason, ..
            }) => {
                assert!(source_url.starts_with("https://"), "{}", model.model_ref);
                assert!(!reason.is_empty(), "{}", model.model_ref);
            }
            None => panic!("{} has no pricing (published or unknown)", model.model_ref),
        }
    }
}

/// Positive prices, cache hits below and cache writes at or above the input
/// price, each written with at most six decimals (no float noise).
fn assert_prices(model_ref: &str, prices: &TokenPrices) {
    assert!(prices.input_per_mtok_usd > 0.0, "{model_ref}");
    assert!(prices.output_per_mtok_usd > 0.0, "{model_ref}");
    if let Some(cached) = prices.cached_input_per_mtok_usd {
        assert!(cached <= prices.input_per_mtok_usd, "{model_ref}");
    }
    for write in [
        prices.cache_write_per_mtok_usd,
        prices.cache_write_1h_per_mtok_usd,
    ]
    .into_iter()
    .flatten()
    {
        assert!(write >= prices.input_per_mtok_usd, "{model_ref}");
    }
    for price in [
        Some(prices.input_per_mtok_usd),
        prices.cached_input_per_mtok_usd,
        prices.cache_write_per_mtok_usd,
        Some(prices.output_per_mtok_usd),
    ]
    .into_iter()
    .flatten()
    {
        assert!(
            price
                .to_string()
                .split('.')
                .nth(1)
                .is_none_or(|d| d.len() <= 6),
            "{model_ref} {price}"
        );
    }
}

#[test]
fn subscription_plans_bill_api_keys_against_quota() {
    let catalog = catalog();
    for provider in setup_providers(&catalog) {
        let expected = if matches!(provider.as_str(), "zai" | "opencode-go") {
            ApiKeyBilling::Subscription
        } else {
            ApiKeyBilling::PerToken
        };
        assert_eq!(catalog.api_key_billing(&provider), expected, "{provider}");
        if expected == ApiKeyBilling::Subscription {
            for model in catalog
                .models
                .iter()
                .filter(|model| model.provider_id == provider)
            {
                assert!(
                    matches!(&model.pricing, Some(ModelPricing::Unknown { reason, .. }) if reason == "subscription_plan"),
                    "{} shows a per-token price on a subscription plan",
                    model.model_ref
                );
            }
        }
    }
}

// test-category: format-pin
#[test]
fn confirmed_routine_presets_and_openai_sol_metadata_are_pinned() {
    let catalog = catalog();
    for (provider, model, effort) in [
        ("openai", "openai/gpt-6.1-sol", ReasoningEffort::Medium),
        (
            "anthropic",
            "anthropic/claude-sonnet-5",
            ReasoningEffort::Medium,
        ),
        ("google", "google/gemini-3.8-flash", ReasoningEffort::Medium),
        ("zai", "zai/glm-5.3", ReasoningEffort::High),
        ("zai-api", "zai-api/glm-5", ReasoningEffort::High),
    ] {
        let preset = catalog.routine_preset(provider).unwrap();
        assert_eq!((preset.model.as_str(), preset.effort), (model, effort));
    }
    for (provider, model) in [
        ("zai", "zai/glm-5.3-flash"),
        ("zai-api", "zai-api/glm-5.3-flash"),
    ] {
        let planning = catalog.provider_presets(provider).unwrap().planning;
        let planning = planning.unwrap();
        assert_eq!(
            (planning.model.as_str(), planning.effort),
            (model, ReasoningEffort::Low)
        );
    }
    let find = |id: &str| lookup::find_model_metadata(Some(id), &catalog.models).unwrap();

    let sol = find("openai/gpt-6.1-sol");
    assert_eq!(sol.status, "latest");
    assert_eq!(sol.context_window_tokens, Some(1_050_000.0));
    assert_eq!(sol.max_output_tokens, Some(128_000.0));
    assert_eq!(sol.default_reasoning_effort, ReasoningEffort::Medium);
    assert_eq!(
        sol.reasoning_efforts,
        [
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::Xhigh,
            ReasoningEffort::Max,
        ]
    );
    assert_eq!(sol.image_input_support.as_deref(), Some("supported"));
    assert_eq!(sol.image_max_width, None);
    assert_eq!(sol.image_max_height, None);
    assert_eq!(sol.image_max_pixels, None);
    assert_eq!(sol.image_max_patches, Some(30_000.0));
    assert_eq!(find("openai/gpt-6-sol").status, "previous");

    for (id, name, effort) in [
        (
            "anthropic/claude-sonnet-5-5",
            "Claude Sonnet 5.5",
            ReasoningEffort::High,
        ),
        (
            "anthropic/claude-haiku-5-5",
            "Claude Haiku 5.5",
            ReasoningEffort::Medium,
        ),
    ] {
        let claude = find(id);
        assert_eq!(claude.display_name, name);
        assert_eq!(claude.status, "latest");
        assert_eq!(claude.context_window_tokens, Some(1_000_000.0));
        assert_eq!(claude.max_output_tokens, Some(128_000.0));
        assert_eq!(claude.default_reasoning_effort, effort);
        assert_eq!(claude.reasoning_efforts, sol.reasoning_efforts, "{id}");
    }
    provider_truth::assert_provider_truth(&catalog);
    let grok = find("xai/grok-4.6");
    assert!(grok.runtime_supported);
    assert_eq!(grok.status, "available");
    assert_eq!(grok.context_window_tokens, Some(500_000.0));
    assert_eq!(grok.default_reasoning_effort, ReasoningEffort::High);
    assert_eq!(grok.reasoning_efforts, sol.reasoning_efforts[..4]);
    assert_eq!(
        find("kimi/kimi-k3").reasoning_efforts,
        [
            ReasoningEffort::Low,
            ReasoningEffort::High,
            ReasoningEffort::Max
        ]
    );
    let latest = catalog
        .models
        .iter()
        .find(|m| m.provider_id == "google" && m.status == "latest");
    let argon = latest.unwrap();
    assert_eq!(argon.model_ref, "google/gemini-4-argon");
    assert_eq!(argon.context_window_tokens, Some(1_048_576.0));
    assert_eq!(argon.max_output_tokens, Some(65_536.0));
    assert_eq!(find("google/gemini-3.8-flash").status, "recommended");
    for id in ["google/gemini-3.7-flash", "google/gemini-3.5-flash"] {
        let model = find(id);
        assert!(!model.runtime_supported, "{id}");
        assert_eq!(model.status, "deprecated");
    }
}

#[test]
fn every_setup_provider_has_a_servable_routine_preset() {
    let catalog = catalog();
    for provider in setup_providers(&catalog) {
        let preset = catalog
            .routine_preset(&provider)
            .unwrap_or_else(|| panic!("{provider} has no presets.routine"));
        let model = lookup::find_model_metadata(Some(&preset.model), &catalog.models)
            .unwrap_or_else(|| panic!("{provider} preset {} is not cataloged", preset.model));
        assert_eq!(model.provider_id, provider);
        assert!(model.runtime_supported, "{}", preset.model);
        assert!(
            model.reasoning_efforts.contains(&preset.effort),
            "{} does not support {:?}",
            preset.model,
            preset.effort
        );
    }
    for worker in &catalog.presets {
        let routine = catalog.routine_preset(&worker.provider_id).unwrap();
        assert_eq!(worker.routine_work.model, routine.model);
        assert_eq!(worker.routine_work.reasoning_effort, routine.effort);
    }
}

// test-category: pure-logic
#[test]
fn supported_image_models_carry_sourced_known_capability_limits() {
    for model in &catalog().models {
        if model.image_input_support.as_deref() != Some("supported") {
            continue;
        }
        image_admission::assert_admits_small_png(model);
        let name = &model.model_ref;
        for field in [
            &model.image_carrier_protocol,
            &model.image_endpoint_profile_id,
            &model.image_capability_revision,
            &model.image_capability_digest,
            &model.image_capability_verified_at,
        ] {
            assert!(field.as_deref().is_some_and(|v| !v.is_empty()), "{name}");
        }
        let source = model.image_capability_source_url.as_deref().unwrap_or("");
        assert!(source.starts_with("https://"), "{name}");
        if model.image_carrier_protocol.as_deref() == Some("zai_mcp_vision") {
            continue;
        }
        assert_ne!(
            model.image_accepted_mime_types.clone().unwrap_or_default(),
            [] as [std::string::String; 0]
        );
        let sources = model.image_limit_sources.clone().unwrap_or_default();
        for (field, value) in [
            (
                ImageLimitField::ImageMaxInlineBytes,
                model.image_max_inline_bytes,
            ),
            (ImageLimitField::ImageMaxWidth, model.image_max_width),
            (ImageLimitField::ImageMaxHeight, model.image_max_height),
            (ImageLimitField::ImageMaxPixels, model.image_max_pixels),
            (ImageLimitField::ImageMaxPatches, model.image_max_patches),
        ] {
            let documented = sources.provider_documented.contains(&field);
            let internal = sources.butler_internal_default.contains(&field);
            match value {
                Some(value) => {
                    assert!(value > 0.0, "{name} {field:?}");
                    assert!(documented != internal, "{name} {field:?} needs one source");
                }
                None => assert!(!documented && !internal, "{name} {field:?} is unverified"),
            }
        }
    }
}

// test-category: pure-logic
#[test]
fn pricing_picks_the_prompt_band_day_and_cache_rates() {
    let catalog = catalog();
    let sol = catalog.pricing("openai/gpt-6-sol").unwrap();
    let short = sol.prices_at(272_000, "2026-09-28").unwrap();
    let long = sol.prices_at(272_001, "2026-09-28").unwrap();
    assert_eq!(short.input_per_mtok_usd, 2.0);
    assert_eq!(short.cache_write_per_mtok_usd, Some(2.5));
    assert_eq!(long.input_per_mtok_usd, 4.0);
    assert_eq!(long.cache_write_per_mtok_usd, Some(5.0));
    let sol_61 = catalog.pricing("openai/gpt-6.1-sol").unwrap();
    let short_61 = sol_61.prices_at(272_000, "2026-10-01").unwrap();
    let long_61 = sol_61.prices_at(272_001, "2026-10-01").unwrap();
    assert_eq!(short_61.input_per_mtok_usd, 2.0);
    assert_eq!(short_61.cached_input_per_mtok_usd, Some(0.1));
    assert_eq!(short_61.cache_write_per_mtok_usd, Some(2.5));
    assert_eq!(short_61.output_per_mtok_usd, 10.0);
    assert_eq!(long_61.input_per_mtok_usd, 4.0);
    assert_eq!(long_61.cached_input_per_mtok_usd, Some(0.2));
    assert_eq!(long_61.cache_write_per_mtok_usd, Some(5.0));
    assert_eq!(long_61.output_per_mtok_usd, 15.0);
    // 1M prompt tokens: 400k cached, 100k written to the cache; 100k output.
    let tokens = RequestTokens {
        input: 1_000_000,
        cached: 400_000,
        cache_write: 100_000,
        cache_write_1h: 0,
        output: 100_000,
    };
    let usd = short.estimate_usd(&tokens).unwrap();
    assert!((usd - (0.5 * 2.0 + 0.4 * 0.2 + 0.1 * 2.5 + 0.1 * 10.0)).abs() < 1e-9);
    let sonnet = catalog.pricing("anthropic/claude-sonnet-5").unwrap();
    let sonnet = sonnet.prices_at(1, "2026-09-28").unwrap();
    let hour = RequestTokens {
        cache_write_1h: 100_000,
        ..tokens
    };
    let usd = sonnet.estimate_usd(&hour).unwrap();
    assert!((usd - (0.5 * 2.0 + 0.4 * 0.2 + 0.1 * 4.0 + 0.1 * 10.0)).abs() < 1e-9);
    // Mixed-TTL Anthropic stub usage: 100 base, 200 read, 50 short writes,
    // 250 hour writes and 20 output tokens; input includes all cache tokens.
    let mixed = RequestTokens {
        input: 600,
        cached: 200,
        cache_write: 300,
        cache_write_1h: 250,
        output: 20,
    };
    assert!((sonnet.estimate_usd(&mixed).unwrap() - 0.001_565).abs() < 1e-12);
    let haiku = catalog.pricing("anthropic/claude-haiku-5-5").unwrap();
    let base = haiku.prices_at(100_000, "2026-10-11").unwrap();
    let long = haiku.prices_at(100_001, "2026-10-11").unwrap();
    assert_eq!(base.input_per_mtok_usd, 0.1);
    assert_eq!(base.cached_input_per_mtok_usd, Some(0.01));
    assert_eq!(base.cache_write_per_mtok_usd, Some(0.125));
    assert_eq!(base.cache_write_1h_per_mtok_usd, Some(0.2));
    assert_eq!(base.output_per_mtok_usd, 0.5);
    assert_eq!(long.input_per_mtok_usd, 0.5);
    assert_eq!(long.cached_input_per_mtok_usd, Some(0.05));
    assert_eq!(long.cache_write_per_mtok_usd, Some(0.625));
    assert_eq!(long.cache_write_1h_per_mtok_usd, Some(1.0));
    assert_eq!(long.output_per_mtok_usd, 2.5);
    // Cache writes on a model with no published cache-write price.
    let mini = catalog.pricing("openai/gpt-5.4-mini").unwrap();
    assert!(
        mini.prices_at(1, "2026-09-28")
            .unwrap()
            .estimate_usd(&tokens)
            .is_none()
    );
    let flash = catalog.pricing("google/gemini-3.8-flash").unwrap();
    assert_eq!(
        flash.prices_at(1, "2026-12-31").unwrap().input_per_mtok_usd,
        0.75
    );
    assert_eq!(
        flash.prices_at(1, "2027-01-01").unwrap().input_per_mtok_usd,
        1.5
    );
    let argon = catalog.pricing("google/gemini-4-argon").unwrap();
    let rates = |day: &str| {
        let p = argon.prices_at(1_048_576, day).unwrap();
        (
            p.input_per_mtok_usd,
            p.cached_input_per_mtok_usd,
            p.cache_write_per_mtok_usd,
            p.output_per_mtok_usd,
        )
    };
    assert_eq!(rates("2026-11-30"), (2.0, Some(0.1), None, 10.0));
    assert_eq!(rates("2026-12-01"), (4.0, Some(0.2), None, 20.0));
    let promo = catalog.pricing("openai/gpt-5.6-sol").unwrap();
    assert!(promo.prices_at(1, "2026-11-21").is_some());
    assert!(promo.prices_at(1, "2026-11-22").is_none());
    assert!(
        catalog
            .pricing("zai/glm-5.3")
            .unwrap()
            .prices_at(1, "2026-09-28")
            .is_none()
    );
}

mod hosted_chat;
