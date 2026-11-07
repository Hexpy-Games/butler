//! The value axis of the chart painter: recharts' `getNiceTickValues` for a domain that starts
//! at zero (`calculateStep`, `getAdaptiveStep`, `getTickOfSingleValue`), so the ticks and the
//! plot's top edge are the numbers recharts chooses.

/// How many ticks the value axis asks for (recharts' default `tickCount`).
pub(super) const TICK_COUNT: usize = 5;

/// `getDigitCount`: the number of digits before the decimal point.
#[expect(clippy::cast_possible_truncation, reason = "a digit count")]
fn digit_count(value: f64) -> i32 {
    if value == 0. {
        return 1;
    }
    value.abs().log10().floor() as i32 + 1
}

/// Rounds away the binary noise before a `ceil`, as the decimal arithmetic recharts uses does
/// not have it.
fn ceil_clean(value: f64) -> f64 {
    ((value * 1e9).round() / 1e9).ceil()
}

/// `getAdaptiveStep`: the easy-to-read step near `rough`, `correction` steps coarser.
fn adaptive_step(rough: f64, allow_decimals: bool, correction: i32) -> f64 {
    if rough <= 0. {
        return 0.;
    }
    let digits = digit_count(rough);
    let scale_value = 10f64.powi(digits);
    let ratio = rough / scale_value;
    let ratio_scale = if digits == 1 { 0.1 } else { 0.05 };
    let amended = (ceil_clean(ratio / ratio_scale) + f64::from(correction)) * ratio_scale;
    let step = (amended * scale_value * 1e9).round() / 1e9;
    if allow_decimals { step } else { step.ceil() }
}

/// The ticks of the domain `0..=max` (`max` is the largest value to show).
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a tick count from a positive ratio"
)]
pub(super) fn ticks(max: f64, allow_decimals: bool) -> Vec<f64> {
    if max <= 0. {
        // `getTickOfSingleValue(0)`: zero is the middle tick.
        return (0..TICK_COUNT).map(|index| index as f64 - 2.).collect();
    }
    let mut correction = 0;
    loop {
        let step = adaptive_step(max / (TICK_COUNT - 1) as f64, allow_decimals, correction);
        let mut up = ceil_clean(max / step) as usize;
        if up + 1 > TICK_COUNT {
            correction += 1;
            continue;
        }
        up += TICK_COUNT - (up + 1);
        return (0..=up).map(|index| index as f64 * step).collect();
    }
}

/// A value as `Number#toString` writes it: whole numbers without a fraction.
pub(super) fn format(value: f64) -> String {
    if (value - value.round()).abs() < 1e-9 {
        format!("{}", value.round())
    } else {
        let text = format!("{value:.6}");
        text.trim_end_matches('0').trim_end_matches('.').to_owned()
    }
}

/// `Number#toLocaleString`: digits grouped by three.
pub(super) fn grouped(value: f64) -> String {
    let text = format(value);
    let (sign, digits) = text
        .strip_prefix('-')
        .map_or(("", text.as_str()), |rest| ("-", rest));
    let (whole, fraction) = digits.split_once('.').map_or((digits, ""), |(w, f)| (w, f));
    let mut out = String::new();
    for (index, ch) in whole.chars().enumerate() {
        if index > 0 && (whole.len() - index) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    let fraction = fraction.get(..fraction.len().min(3)).unwrap_or("");
    if fraction.is_empty() {
        format!("{sign}{out}")
    } else {
        format!("{sign}{out}.{fraction}")
    }
}
