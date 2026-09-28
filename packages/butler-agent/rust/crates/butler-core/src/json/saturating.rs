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
        /// Truncates toward zero, maps NaN to 0 and saturates at the target bounds.
        pub fn $name(value: f64) -> $target {
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
pub fn saturating_i64(value: f64) -> i64 {
    value as i64
}

#[expect(
    clippy::cast_possible_truncation,
    reason = "float-to-int `as` saturates and truncates by definition; that is the intent"
)]
/// Signed targets cannot lose a sign; only truncation is possible.
pub fn saturating_i32(value: f64) -> i32 {
    value as i32
}
