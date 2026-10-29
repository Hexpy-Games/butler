/// Joins an answer cut off at the output limit with its continuation, which
/// repeats the cut last line first; one that does not is appended as written.
pub(super) fn join_cut(cut: &str, next: &str) -> String {
    let line = cut.rfind('\n').map_or(0, |index| index + 1);
    if line < cut.len() && next.starts_with(&cut[line..]) {
        format!("{}{next}", &cut[..line])
    } else {
        format!("{cut}{next}")
    }
}
