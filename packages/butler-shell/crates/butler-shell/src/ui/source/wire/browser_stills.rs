//! Wire types for the P2 wave-2 `browser_stills` unit (mirror TS, `/// TS: path:line`).
use serde::Deserialize;

/// TS: packages/butler-app/client/ui/src/components/browser/BrowserStepStill.tsx:9 Still (inline still_file)
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct BrowserStillFile {
    pub(crate) url: String,
    #[serde(default)]
    pub(crate) signed_url: Option<String>,
}

/// TS: packages/butler-app/client/ui/src/components/browser/BrowserStepStill.tsx:9 Still
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct BrowserStill {
    pub(crate) tab: String,
    #[serde(default)]
    pub(crate) step: Option<i64>,
    #[serde(default)]
    pub(crate) state: Option<String>,
    #[serde(default)]
    pub(crate) reason: Option<String>,
    #[serde(default)]
    pub(crate) still_file: Option<BrowserStillFile>,
}

/// TS: packages/butler-app/client/ui/src/components/browser/BrowserStepStill.tsx:10 Delivery
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct BrowserStillDelivery {
    pub(crate) act_id: String,
    pub(crate) complete: bool,
    pub(crate) steps: Vec<BrowserStill>,
}

/// TS: packages/butler-app/client/ui/src/components/browser/BrowserStepStill.tsx:12 `still_pending`
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct BrowserStillPending {
    pub(crate) id: String,
    pub(crate) session: String,
}

/// TS: packages/butler-app/client/ui/src/app/types.ts:1080 OperationOutputView
/// (with the `browser_stills` delivery of BrowserStepStill.tsx:41).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct BrowserStillOutput {
    #[serde(default)]
    pub(crate) content: String,
    #[serde(default)]
    pub(crate) browser_stills: Option<BrowserStillDelivery>,
}
