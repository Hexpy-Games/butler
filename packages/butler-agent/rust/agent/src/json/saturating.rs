//! Saturating float-to-integer conversion for JS-number values.
//!
//! These have exactly Rust's `as` semantics for floats: the fraction is
//! truncated toward zero, NaN becomes 0 and out-of-range values saturate at the
//! target's bounds. Callers validate ranges where a bound is meaningful; these
//! helpers only name the conversion so it is not an unexplained cast.

macro_rules! saturating {
    ($($name:ident -> $target:ty),* $(,)?) => {$(
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "float-to-int `as` saturates and truncates by definition; that is the intent"
        )]
        pub(crate) fn $name(value: f64) -> $target {
            value as $target
        }
    )*};
}

saturating! {
    saturating_usize -> usize,
    saturating_u64 -> u64,
    saturating_u32 -> u32,
    saturating_u16 -> u16,
}

/// Signed targets cannot lose a sign; only truncation is possible.
#[expect(
    clippy::cast_possible_truncation,
    reason = "float-to-int `as` saturates and truncates by definition; that is the intent"
)]
pub(crate) fn saturating_i64(value: f64) -> i64 {
    value as i64
}

#[expect(
    clippy::cast_possible_truncation,
    reason = "float-to-int `as` saturates and truncates by definition; that is the intent"
)]
pub(crate) fn saturating_i32(value: f64) -> i32 {
    value as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversions_match_as_semantics() {
        assert_eq!(saturating_usize(f64::NAN), 0);
        assert_eq!(saturating_usize(-3.7), 0);
        assert_eq!(saturating_usize(3.7), 3);
        assert_eq!(saturating_u64(f64::INFINITY), u64::MAX);
        assert_eq!(saturating_u32(1e12), u32::MAX);
        assert_eq!(saturating_u16(65_535.9), u16::MAX);
        assert_eq!(saturating_i64(-3.7), -3);
        assert_eq!(saturating_i64(f64::NEG_INFINITY), i64::MIN);
        assert_eq!(saturating_i32(1e12), i32::MAX);
    }
}
