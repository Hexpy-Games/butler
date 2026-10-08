//! Consistency pins over the bundled static catalog and the pure preset and
//! pricing rules.

use std::collections::BTreeSet;

use super::lookup::provider_auth_methods;
use super::*;

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

#[test]
fn every_static_model_has_a_tier_and_pricing() {
    for model in &catalog().models {
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
    for (provider, model) in [
        ("openai", "openai/gpt-6.1-sol"),
        ("anthropic", "anthropic/claude-sonnet-5"),
        ("google", "google/gemini-3.8-flash"),
        ("zai", "zai/glm-5"),
        ("zai-api", "zai-api/glm-5"),
    ] {
        let preset = catalog.routine_preset(provider).unwrap();
        assert_eq!(preset.model, model);
        assert_eq!(preset.effort, ReasoningEffort::Medium);
    }

    let sol = catalog
        .models
        .iter()
        .find(|model| model.model_ref == "openai/gpt-6.1-sol")
        .unwrap();
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
    let previous_sol = catalog
        .models
        .iter()
        .find(|model| model.model_ref == "openai/gpt-6-sol")
        .unwrap();
    assert_eq!(previous_sol.status, "previous");
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
        assert!(
            !model
                .image_accepted_mime_types
                .clone()
                .unwrap_or_default()
                .is_empty()
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

/// Provider, static preset, refreshed ids, "runs at effort" check, expected model.
type Case<'a> = (
    &'a str,
    &'a ModelPreset,
    &'a [&'a str],
    &'a dyn Fn(&str, ReasoningEffort) -> bool,
    &'a str,
);

#[test]
fn routine_preset_upgrades_only_to_a_newer_same_tier_model_at_the_same_effort() {
    let sol = ModelPreset {
        model: "openai/gpt-6-sol".into(),
        effort: ReasoningEffort::Medium,
    };
    let sonnet = ModelPreset {
        model: "anthropic/claude-sonnet-5".into(),
        effort: ReasoningEffort::Medium,
    };
    let flash = ModelPreset {
        model: "google/gemini-3.8-flash".into(),
        effort: ReasoningEffort::Medium,
    };
    let kimi = ModelPreset {
        model: "kimi/kimi-k2.7-code".into(),
        effort: ReasoningEffort::Medium,
    };
    let all = |_: &str, _: ReasoningEffort| true;
    let none = |_: &str, _: ReasoningEffort| false;
    let no_medium = |_: &str, effort: ReasoningEffort| effort != ReasoningEffort::Medium;
    let cases: [Case<'_>; 9] = [
        (
            "openai",
            &sol,
            &["gpt-6.1-sol", "gpt-7-astra"],
            &all,
            "openai/gpt-6.1-sol",
        ),
        (
            "openai",
            &sol,
            &["gpt-5.6-sol", "gpt-6-luna"],
            &all,
            "openai/gpt-6-sol",
        ),
        ("openai", &sol, &["gpt-6.1-sol"], &none, "openai/gpt-6-sol"),
        (
            "openai",
            &sol,
            &["gpt-6.1-sol"],
            &no_medium,
            "openai/gpt-6-sol",
        ),
        (
            "anthropic",
            &sonnet,
            &["claude-sonnet-5-1", "claude-opus-6"],
            &all,
            "anthropic/claude-sonnet-5-1",
        ),
        (
            "anthropic",
            &sonnet,
            &["claude-haiku-5"],
            &all,
            "anthropic/claude-sonnet-5",
        ),
        (
            "google",
            &flash,
            &["gemini-3.9-flash-lite", "gemini-3.9-flash"],
            &all,
            "google/gemini-3.9-flash",
        ),
        (
            "google",
            &flash,
            &["gemini-3.9-flash-preview-10-2026"],
            &all,
            "google/gemini-3.8-flash",
        ),
        ("kimi", &kimi, &["kimi-k3.1"], &all, "kimi/kimi-k2.7-code"),
    ];
    for (provider, preset, refreshed, runs, expected) in cases {
        let refreshed = refreshed
            .iter()
            .map(|id| (*id).to_owned())
            .collect::<Vec<_>>();
        let upgraded = upgrade_routine_preset(provider, preset, &refreshed, runs);
        assert_eq!(upgraded.model, expected, "{provider} {refreshed:?}");
        assert_eq!(upgraded.effort, ReasoningEffort::Medium);
    }
}
