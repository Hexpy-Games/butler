//! `expect-clipboard*`: what the shell last wrote to the system clipboard.
use super::Harness;
use anyhow::ensure;

pub(super) fn expect_clipboard_prefix(h: &mut Harness, arg: &str) -> anyhow::Result<()> {
    let expected: String = serde_json::from_str(arg)?;
    let actual =
        h.cx.update(|cx| cx.read_from_clipboard().and_then(|item| item.text()));
    ensure!(
        actual
            .as_ref()
            .is_some_and(|text| text.starts_with(&expected)),
        "clipboard {actual:?}, expected prefix {expected:?}"
    );
    Ok(())
}

pub(super) fn expect_clipboard_contains(h: &mut Harness, arg: &str) -> anyhow::Result<()> {
    let expected: String = serde_json::from_str(arg)?;
    let actual =
        h.cx.update(|cx| cx.read_from_clipboard().and_then(|item| item.text()));
    ensure!(
        actual.as_ref().is_some_and(|text| text.contains(&expected)),
        "clipboard {actual:?}, expected substring {expected:?}"
    );
    Ok(())
}

pub(super) fn expect_clipboard(h: &mut Harness, arg: &str) -> anyhow::Result<()> {
    let expected: Option<String> = serde_json::from_str(arg)?;
    let actual =
        h.cx.update(|cx| cx.read_from_clipboard().and_then(|item| item.text()));
    ensure!(
        actual == expected,
        "clipboard {actual:?}, expected {expected:?}"
    );
    Ok(())
}
