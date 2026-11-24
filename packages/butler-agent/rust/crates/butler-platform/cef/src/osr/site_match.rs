pub(super) fn valid_site(s: &str) -> bool {
    s.contains('.')
        && s.split('.').all(|label| {
            !label.is_empty()
                && label
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
}

pub(super) fn cookie_matches(domain: &str, site: &str) -> bool {
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    domain == site || domain.ends_with(&format!(".{site}"))
}

pub(super) fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if !matches!(scheme, "http" | "https") {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    Some(format!("{scheme}://{}", &rest[..end]))
}

pub(super) fn tuple_origin(candidate: &str) -> Option<String> {
    let url = url::Url::parse(candidate).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let origin = url.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

pub(super) fn sign_out_origins(site: &str) -> Vec<String> {
    [
        format!("https://{site}"),
        format!("https://www.{site}"),
        format!("http://{site}"),
    ]
    .iter()
    .filter_map(|candidate| tuple_origin(candidate))
    .collect()
}
