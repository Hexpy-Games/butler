//! Cost-reason table for priced, unpriced and mixed usage.

use butler_models::models::{ModelPricing, TokenPrices};

use super::*;

fn event(model: &str, prompt: f64, cached: f64, total: f64) -> UsageEvent {
    UsageEvent {
        ts: 1,
        model: model.into(),
        scope: "btcc-guided:s".into(),
        prompt_tokens: prompt,
        cached_tokens: cached,
        total_tokens: Some(total),
        reasoning_tokens: None,
        auth_mode: None,
    }
}

fn published() -> ModelPricing {
    ModelPricing::Published {
        base: TokenPrices {
            input_per_mtok_usd: 1.0,
            cached_input_per_mtok_usd: Some(0.1),
            output_per_mtok_usd: 10.0,
        },
        prompt_tiers: Vec::new(),
        source_url: "https://example.com/pricing".into(),
        as_of: "2026-09-28".into(),
    }
}

/// Rows `(model, priced)`, then the expected availability, USD and reason.
type Case<'a> = (&'a [(&'a str, bool)], bool, Option<f64>, Option<CostReason>);

#[test]
fn cost_reason_follows_which_models_are_priced() {
    let priced = published();
    let cases: [Case<'_>; 4] = [
        (&[], true, Some(0.0), None),
        (&[("a/priced", true)], true, Some(0.000_119), None),
        (
            &[("a/priced", true), ("b/unpriced", false)],
            true,
            Some(0.000_119),
            Some(CostReason::PartialPricing),
        ),
        (
            &[("b/unpriced", false)],
            false,
            None,
            Some(CostReason::PricingUnknown),
        ),
    ];
    for (rows, available, usd, reason) in cases {
        let mut totals = UsageTotals::default();
        for (model, has_price) in rows {
            // 100 prompt tokens (90 cached) and 10 output tokens.
            let pricing = has_price.then_some(&priced);
            totals.add(&event(model, 100.0, 90.0, 110.0), pricing);
        }
        let cost = totals.cost();
        assert_eq!(cost.available, available, "{rows:?}");
        assert_eq!(cost.reason, reason, "{rows:?}");
        match (cost.usd, usd) {
            (Some(actual), Some(expected)) => {
                assert!((actual - expected).abs() < 1e-12, "{rows:?}: {actual}");
            }
            (actual, expected) => assert_eq!(actual, expected, "{rows:?}"),
        }
    }
}
