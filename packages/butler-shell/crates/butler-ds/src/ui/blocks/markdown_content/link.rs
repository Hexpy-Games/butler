//! MarkdownLink (`MarkdownLink.tsx`): an absolute http(s) link is an external `InlineReference`
//! (favicon or globe, title or domain, the full URL in the tooltip); a mailto, fragment or
//! relative link stays a plain anchor in the accent colour, handed to the system.
use gpui::App;

/// `isExternalHref`: an absolute http(s) URL with a host.
pub(super) fn is_external(href: &str) -> bool {
    let lower = href.to_ascii_lowercase();
    let Some(rest) = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
    else {
        return false;
    };
    rest.split(['/', '?', '#'])
        .next()
        .is_some_and(|authority| !authority.is_empty() && !authority.starts_with(':'))
}

/// Opens a link in the system handler: a fragment has nowhere to go in a native view.
pub(super) fn open(href: &str, cx: &mut App) {
    if !href.is_empty() && !href.starts_with('#') {
        cx.open_url(href);
    }
}

/// The text an external link shows: its label, or the host when the label is empty or the URL
/// itself (`ExternalReference`).
pub(super) fn label(text: &str, href: &str) -> String {
    let bare = |url: &str| {
        let url = url.split_once("://").map_or(url, |(_, rest)| rest);
        url.trim_end_matches('/').to_lowercase()
    };
    if text.trim().is_empty() || bare(text.trim()) == bare(href) {
        let rest = href.split_once("://").map_or(href, |(_, rest)| rest);
        let host = rest.split(['/', '?', '#', ':']).next().unwrap_or(rest);
        return host.strip_prefix("www.").unwrap_or(host).to_owned();
    }
    text.to_owned()
}
