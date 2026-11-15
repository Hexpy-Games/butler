//! Chrome switches that turn off Chrome's background services and its outbound calls to Google:
//! component downloads, sync, crash reports, Translate and similar. The headless executor
//! passes them on its command line; the in-app OSR runtime appends them in its browser process,
//! then [`VISIBLE_ONLY`]. Always compiled (no `cef` feature) so the executor shares this one list.

/// The value of `--disable-features` in [`QUIET`].
pub const DISABLED_FEATURES: &str =
    "Translate,MediaRouter,OptimizationHints,DialMediaRouteProvider";

/// Switch names without leading dashes, with their value where they take one.
pub const QUIET: &[(&str, Option<&str>)] = &[
    ("no-first-run", None),
    ("no-default-browser-check", None),
    ("disable-background-networking", None),
    ("disable-component-update", None),
    ("disable-sync", None),
    ("disable-breakpad", None),
    ("disable-crash-reporter", None),
    ("disable-domain-reliability", None),
    ("disable-features", Some(DISABLED_FEATURES)),
];

/// [`QUIET`] as command-line arguments: `--name` or `--name=value`.
pub fn quiet_args() -> impl Iterator<Item = String> {
    QUIET.iter().map(|(name, value)| match value {
        Some(value) => format!("--{name}={value}"),
        None => format!("--{name}"),
    })
}

/// What the in-app browser appends after [`QUIET`]: Google calls those switches leave on, each
/// measured with a net log on a fresh and a reused profile (#2288). Not for the executor, whose
/// guard proxy already refuses these hosts.
pub const VISIBLE_ONLY: &[(&str, Option<&str>)] = &[
    // The on-device AI models manifest (component ceofaddefefcbblgcgnibnonglccbfja) is registered
    // at startup by the optimization guide, not by the components that --disable-component-update
    // skips; no feature gates it. With this switch Chrome reads a local manifest instead (none
    // here: one "Failed to read override config file" log line) and never registers the
    // component, so update.googleapis.com and edgedl.me.gvt1.com are not contacted.
    ("optimization-guide-manifest-override", None),
    // NetworkTimeServiceQuerying: clients2.google.com/time. AimEnabled: the omnibox AI Mode
    // eligibility fetch, www.google.com/async/folae (whose reply names csp.withgoogle.com).
    (
        "disable-features",
        Some("NetworkTimeServiceQuerying,AimEnabled"),
    ),
];

/// A `--disable-features` value holding `existing`'s features and then `add`'s that `existing`
/// lacks.
pub fn merge_disabled_features(existing: &str, add: &str) -> String {
    let mut features: Vec<&str> = existing.split(',').filter(|f| !f.is_empty()).collect();
    for feature in add.split(',') {
        if !features.contains(&feature) {
            features.push(feature);
        }
    }
    features.join(",")
}
