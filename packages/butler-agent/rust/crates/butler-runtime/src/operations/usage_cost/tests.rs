//! Cost table: priced, unpriced, cache-priced, time-limited and mixed usage.

use butler_models::models::{ModelPricing, NextPrices, TokenPrices};

use super::*;

/// 2026-09-28T00:00:00Z.
const SEP_28: i64 = 1_790_553_600_000;
/// 2027-01-02T00:00:00Z.
const JAN_2: i64 = 1_798_848_000_000;

struct Row {
    model: &'static str,
    ts: i64,
    cached: f64,
    cache_write: f64,
}

fn event(row: &Row) -> UsageEvent {
    // 1,000 prompt tokens and 100 output tokens.
    UsageEvent {
        ts: row.ts,
        model: row.model.into(),
        scope: "btcc-guided:s".into(),
        prompt_tokens: 1_000.0,
        cached_tokens: row.cached,
        cache_write_tokens: Some(row.cache_write),
        cache_write_1h_tokens: None,
        total_tokens: Some(1_100.0),
        reasoning_tokens: None,
        auth_mode: None,
    }
}

fn prices(cached: Option<f64>, cache_write: Option<f64>) -> TokenPrices {
    TokenPrices {
        input_per_mtok_usd: 1.0,
        cached_input_per_mtok_usd: cached,
        cache_write_per_mtok_usd: cache_write,
        cache_write_1h_per_mtok_usd: None,
        output_per_mtok_usd: 10.0,
    }
}

fn published(
    base: TokenPrices,
    valid_until: Option<&str>,
    next: Option<TokenPrices>,
) -> ModelPricing {
    ModelPricing::Published {
        base,
        prompt_tiers: Vec::new(),
        valid_until: valid_until.map(str::to_owned),
        next: next.map(|base| NextPrices {
            base,
            prompt_tiers: Vec::new(),
        }),
        source_url: "https://example.com/pricing".into(),
        as_of: "2026-09-28".into(),
    }
}

fn pricing(model: &str) -> Option<ModelPricing> {
    match model {
        "a/full" => Some(published(prices(Some(0.1), Some(1.25)), None, None)),
        "a/no-cache" => Some(published(prices(None, None), None, None)),
        "a/promo" => Some(published(prices(Some(0.1), None), Some("2026-12-31"), None)),
        "a/until" => Some(published(
            prices(Some(0.1), None),
            Some("2026-12-31"),
            Some(prices(Some(0.2), None)),
        )),
        _ => None,
    }
}

/// Rows, expected USD (or `None`) and reason.
type Case = (&'static [Row], Option<f64>, Option<CostReason>);

#[test]
fn every_request_must_be_priced_for_an_estimate() {
    // 1,000 input (1e-3 at $1) + 100 output (1e-3 at $10) = 0.002.
    let cases: [Case; 8] = [
        (&[], Some(0.0), None),
        (
            &[Row {
                model: "a/full",
                ts: SEP_28,
                cached: 400.0,
                cache_write: 100.0,
            }],
            // 500 uncached + 400 × 0.1 + 100 × 1.25 per MTok, plus output.
            Some((500.0 + 40.0 + 125.0 + 1_000.0) / 1e6),
            None,
        ),
        (
            &[Row {
                model: "a/no-cache",
                ts: SEP_28,
                cached: 0.0,
                cache_write: 0.0,
            }],
            Some(0.002),
            None,
        ),
        (
            &[Row {
                model: "a/no-cache",
                ts: SEP_28,
                cached: 10.0,
                cache_write: 0.0,
            }],
            None,
            Some(CostReason::CachePriceUnknown),
        ),
        (
            &[
                Row {
                    model: "a/full",
                    ts: SEP_28,
                    cached: 0.0,
                    cache_write: 0.0,
                },
                Row {
                    model: "b/unpriced",
                    ts: SEP_28,
                    cached: 0.0,
                    cache_write: 0.0,
                },
            ],
            None,
            Some(CostReason::PricingUnknown),
        ),
        (
            &[Row {
                model: "a/promo",
                ts: SEP_28,
                cached: 0.0,
                cache_write: 0.0,
            }],
            Some(0.002),
            None,
        ),
        (
            &[Row {
                model: "a/promo",
                ts: JAN_2,
                cached: 0.0,
                cache_write: 0.0,
            }],
            None,
            Some(CostReason::PricingUnknown),
        ),
        (
            &[Row {
                model: "a/until",
                ts: JAN_2,
                cached: 100.0,
                cache_write: 0.0,
            }],
            // The next price applies: 900 uncached + 100 × 0.2, plus output.
            Some((900.0 + 20.0 + 1_000.0) / 1e6),
            None,
        ),
    ];
    for (rows, usd, reason) in cases {
        let mut totals = UsageTotals::default();
        for row in rows {
            totals.add(&event(row), pricing(row.model).as_ref());
        }
        let cost = totals.cost();
        assert_eq!(cost.reason, reason, "{}", rows.len());
        assert_eq!(cost.available, reason.is_none());
        match (cost.usd, usd) {
            (Some(actual), Some(expected)) => {
                assert!((actual - expected).abs() < 1e-15, "{actual} != {expected}");
            }
            (actual, expected) => assert_eq!(actual, expected),
        }
    }
}
