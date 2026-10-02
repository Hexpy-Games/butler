//! Where an Agent archive may be fetched from.

pub(super) fn redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if redirect_allowed(attempt.previous(), attempt.url()) {
            attempt.follow()
        } else {
            attempt.stop()
        }
    })
}

/// Whether a download may be redirected from the first URL of `previous` (or
/// this one) to `next`: to https; to plain http only within this machine,
/// and only when the download began on this machine; never more than five
/// times.
pub(super) fn redirect_allowed(previous: &[url::Url], next: &url::Url) -> bool {
    let loopback = |url: &url::Url| {
        url.host_str()
            .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1"))
    };
    if previous.len() >= 5 {
        return false;
    }
    match next.scheme() {
        "https" => true,
        "http" => loopback(next) && previous.first().is_none_or(loopback),
        _ => false,
    }
}

/// Whether `source` may be downloaded: a local file, `https`, or `http` to
/// this machine.
pub(super) fn secure_source(source: &str) -> bool {
    // Native absolute paths (including drive-letter paths) are files, even
    // when a URL parser interprets their prefix as a scheme.
    if std::path::Path::new(source).is_absolute() {
        return true;
    }
    let Ok(url) = url::Url::parse(source) else {
        // A plain path is a local file.
        return !source.contains("://");
    };
    match url.scheme() {
        "https" | "file" => true,
        "http" => url
            .host_str()
            .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{redirect_allowed, secure_source};

    fn url(text: &str) -> url::Url {
        url::Url::parse(text).expect("test url")
    }

    // test-category: security
    #[test]
    fn a_redirect_never_goes_from_https_or_a_remote_host_to_plain_http() {
        let local_manifest = std::env::current_dir()
            .expect("test directory")
            .join("manifest.json");
        assert!(secure_source(&local_manifest.to_string_lossy()));
        assert!(secure_source("manifest.json"));
        assert!(secure_source("https://example.com/manifest.json"));
        assert!(!secure_source("http://example.com/manifest.json"));
        assert!(!secure_source("custom:manifest.json"));
        let remote = [url("https://example.com/a")];
        let local = [url("http://127.0.0.1:1/a")];
        assert!(redirect_allowed(&remote, &url("https://cdn.example.com/a")));
        assert!(!redirect_allowed(&remote, &url("http://127.0.0.1:2/a")));
        assert!(!redirect_allowed(&remote, &url("http://example.com/a")));
        assert!(redirect_allowed(&local, &url("http://localhost:2/a")));
        assert!(!redirect_allowed(&local, &url("http://example.com/a")));
        assert!(!redirect_allowed(&local, &url("ftp://127.0.0.1/a")));
        let many: Vec<_> = (0..5).map(|_| url("https://example.com/a")).collect();
        assert!(!redirect_allowed(&many, &url("https://example.com/b")));
    }
}
