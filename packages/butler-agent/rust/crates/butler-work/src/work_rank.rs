//! Base-62 fractional ranks for plan/task order, compared as plain bytes.
const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// Allocate between valid ranks produced by this function, with `a < b` when
/// both are present. Valid ranks are nonempty base-62 strings not ending in 0.
/// Missing bounds represent infinities. A digit provides at least five binary
/// subdivisions: repeated insertion into one shrinking gap adds at most one
/// character per five insertions (plus the common prefix). No fixed precision
/// or machine-sized counter limits the number of insertions.
#[must_use]
pub fn between(a: Option<&str>, b: Option<&str>) -> String {
    let lower = a.unwrap_or_default().as_bytes();
    let upper = b.unwrap_or_default().as_bytes();
    let mut result = String::new();
    let mut index = 0;
    let mut upper_open = b.is_none();
    loop {
        let lo = lower
            .get(index)
            .and_then(|c| DIGITS.iter().position(|d| d == c))
            .unwrap_or(0);
        let hi = if upper_open {
            DIGITS.len()
        } else {
            upper
                .get(index)
                .and_then(|c| DIGITS.iter().position(|d| d == c))
                .unwrap_or(DIGITS.len())
        };
        if hi > lo + 1 {
            result.push(char::from(DIGITS[lo + (hi - lo) / 2]));
            return result;
        }
        result.push(char::from(DIGITS[lo]));
        if lo < hi {
            upper_open = true;
        }
        index += 1;
    }
}
