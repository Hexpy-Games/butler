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
                source_url,
                as_of,
            }) => {
                assert!(source_url.starts_with("https://"), "{}", model.model_ref);
                assert_eq!(as_of.len(), 10, "{}", model.model_ref);
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

fn assert_prices(model_ref: &str, prices: &TokenPrices) {
    assert!(prices.input_per_mtok_usd > 0.0, "{model_ref}");
    assert!(prices.output_per_mtok_usd > 0.0, "{model_ref}");
    if let Some(cached) = prices.cached_input_per_mtok_usd {
        assert!(cached <= prices.input_per_mtok_usd, "{model_ref}");
    }
}

#[test]
fn owner_confirmed_routine_presets_are_pinned() {
    let catalog = catalog();
    for (provider, model) in [
        ("openai", "openai/gpt-6-sol"),
        ("anthropic", "anthropic/claude-sonnet-5"),
        ("google", "google/gemini-3.8-flash"),
    ] {
        let preset = catalog.routine_preset(provider).unwrap();
        assert_eq!(preset.model, model);
        assert_eq!(preset.effort, ReasoningEffort::Medium);
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

#[test]
fn supported_image_models_carry_a_complete_sourced_capability() {
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
        ] {
            assert!(value.is_some_and(|v| v > 0.0), "{name} {field:?}");
            let documented = sources.provider_documented.contains(&field);
            let internal = sources.butler_internal_default.contains(&field);
            assert!(documented != internal, "{name} {field:?} needs one source");
        }
    }
}

#[test]
fn pricing_picks_the_prompt_band_and_estimates_usd() {
    let pricing = catalog().pricing("openai/gpt-6-sol").unwrap();
    let short = pricing.prices_for(272_000).unwrap();
    let long = pricing.prices_for(272_001).unwrap();
    assert_eq!(short.input_per_mtok_usd, 2.0);
    assert_eq!(long.input_per_mtok_usd, 4.0);
    // 1M prompt tokens of which 400k cached, 100k output.
    let usd = short.estimate_usd(1_000_000, 400_000, 100_000);
    assert!((usd - (0.6 * 2.0 + 0.4 * 0.2 + 0.1 * 10.0)).abs() < 1e-9);
    assert!(
        catalog()
            .pricing("zai/glm-5.3")
            .unwrap()
            .prices_for(1)
            .is_none()
    );
}

/// Provider, static preset, refreshed ids, servable check, expected model.
type Case<'a> = (
    &'a str,
    &'a ModelPreset,
    &'a [&'a str],
    &'a dyn Fn(&str) -> bool,
    &'a str,
);

#[test]
fn routine_preset_upgrades_only_to_a_newer_servable_same_tier_model() {
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
    let all = |_: &str| true;
    let none = |_: &str| false;
    let cases: [Case<'_>; 8] = [
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
    for (provider, preset, refreshed, servable, expected) in cases {
        let refreshed = refreshed
            .iter()
            .map(|id| (*id).to_owned())
            .collect::<Vec<_>>();
        let upgraded = upgrade_routine_preset(provider, preset, &refreshed, servable);
        assert_eq!(upgraded.model, expected, "{provider} {refreshed:?}");
        assert_eq!(upgraded.effort, ReasoningEffort::Medium);
    }
}
