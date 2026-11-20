//! Chrome switches that turn off Chrome's background services and its outbound calls to Google:
//! component downloads, sync, crash reports, Translate and similar. The headless executor
//! passes them on its command line; the in-app OSR runtime appends them in its browser process,
//! then [`VISIBLE_ONLY`]. Always compiled (no `cef` feature) so the executor shares this one list.

/// The OSR browser process appends these two to every helper (Windows): the name of the App's
/// kill-on-close Job Object, and the App's process id (`crate::job` decides from it whether a
/// helper joins the job).
pub const OSR_JOB: &str = "butler-osr-job";
/// See [`OSR_JOB`].
pub const OSR_APP: &str = "butler-osr-app";

/// The value of `--disable-features` in [`QUIET`]. SegmentationPlatform(UkmEngine): Chrome's
/// on-device usage segmentation, unused here, writes `segmentation_platform/ukm_db` and
/// `shared_proto_db` on timers after start (#2249).
pub const DISABLED_FEATURES: &str = "Translate,MediaRouter,OptimizationHints,DialMediaRouteProvider,SegmentationPlatform,SegmentationPlatformUkmEngine";

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

/// [`QUIET`] as the headless executor's command-line arguments: `--name` or `--name=value`, with
/// [`HEADLESS_ONLY_FEATURES`] added to `--disable-features`.
pub fn headless_args() -> impl Iterator<Item = String> {
    QUIET.iter().map(|(name, value)| match value {
        Some(value) if *name == "disable-features" => format!(
            "--{name}={}",
            merge_disabled_features(value, HEADLESS_ONLY_FEATURES)
        ),
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

/// What the headless executor disables on top of [`DISABLED_FEATURES`]. On macOS Chrome clones its
/// whole app bundle at every start so a running Chrome survives its own in-place updater; the
/// headless host never removes that clone, whatever way it exits (measured: one left per start,
/// about 600 MB apparent, real bytes once the bundle changes); Chromium clears them only at reboot.
/// The headless host lives at most a minute past its last tab and uses the mock keychain; Chrome
/// for Testing builds without it. Not for the in-app browser yet: in a harness run on macOS it
/// removed its clone 0.07 to 0.21 s after a clean exit, and a kill or crash left one until reboot.
/// Whether disabling the feature changes anything with the real OS password store was not tested
/// (with the mock keychain it makes no difference).
pub const HEADLESS_ONLY_FEATURES: &str = "MacAppCodeSignClone";

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
