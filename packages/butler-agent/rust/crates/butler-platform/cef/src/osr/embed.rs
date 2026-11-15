//! Capability pages cannot replace the application or leak their referrer.
use super::{
    OsrError, OsrEvent, OsrProfile, OsrRuntime,
    state::{Events, PageRef},
};
use cef::{ImplFrame as _, ImplRequest as _};

pub(super) struct Policy {
    initial: String,
    origin: Option<(String, String, String)>,
}

impl OsrRuntime {
    pub fn open_embed(&self, page: u64, url: &str, profile: OsrProfile) -> Result<(), OsrError> {
        self.open_page(
            page,
            url,
            (1, 1),
            1.,
            profile,
            Some(Policy {
                initial: url.to_owned(),
                origin: origin(url),
            }),
        )
    }
}

pub(super) fn before(
    shared: &PageRef,
    events: &Events,
    frame: Option<&mut cef::Frame>,
    request: Option<&mut cef::Request>,
) -> i32 {
    let page = shared.borrow();
    let Some(policy) = &page.embed else {
        return 0;
    };
    let Some(request) = request else {
        return 0;
    };
    request.set_referrer(Some(&"".into()), cef::ReferrerPolicy::NO_REFERRER);
    if frame.is_none_or(|f| f.is_main() == 0) {
        return 0;
    }
    let target = cef::CefString::from(&request.url()).to_string();
    if target == policy.initial || policy.origin.is_some() && origin(&target) == policy.origin {
        return 0;
    }
    events.emit(OsrEvent::PopupNewTab { url: target });
    1
}

fn origin(url: &str) -> Option<(String, String, String)> {
    let mut parts = cef::Urlparts::default();
    if cef::parse_url(Some(&url.into()), Some(&mut parts)) == 0 {
        return None;
    }
    let scheme = parts.scheme.to_string();
    if !matches!(scheme.as_str(), "http" | "https") {
        return None;
    }
    Some((scheme, parts.host.to_string(), parts.port.to_string()))
}
