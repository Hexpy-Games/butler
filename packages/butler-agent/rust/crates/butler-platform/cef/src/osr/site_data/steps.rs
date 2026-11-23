use super::{
    super::{
        site_match::{sign_out_origins, tuple_origin},
        state::Phase,
    },
    Completed, Deferred, Next, OsrError, Session, SiteDataDone, Sweep, Then,
};
use cef::*;
use std::{
    cell::RefCell,
    collections::BTreeSet,
    fmt::Write as _,
    rc::{Rc, Weak},
    time::{Duration, Instant},
};

const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const STORAGE: &str =
    "cookies,file_systems,indexeddb,local_storage,shader_cache,service_workers,cache_storage";

fn cancellable(next: Next) -> Rc<Then> {
    Rc::new(Then {
        next: RefCell::new(Some(next)),
        default: Some("site_data_cancelled".into()),
    })
}

pub(super) fn finish(s: &Session, result: Result<(), OsrError>) {
    if s.finished.replace(true) {
        return;
    }
    drop(std::mem::take(&mut *s.pending.borrow_mut()));
    if let Some(state) = s.state.upgrade()
        && let Some(page) = state.pages.borrow().get(&s.page)
    {
        let mut page = page.borrow_mut();
        if page.phase != Phase::Closing {
            page.phase = Phase::Closing;
            page.release_frames();
        }
    }
    s.host.close_browser(1);
    let completion = s.completion.borrow_mut().take();
    if let Some(next) = completion {
        let result = if result.is_ok() && s.failed.get() {
            Err(OsrError("site_data_partial".into()))
        } else {
            result
        };
        next(result);
    }
}

fn idle_timeout(session: Weak<Session>, delay: Duration) {
    let timeout: Box<dyn FnOnce()> = Box::new(move || {
        let Some(s) = session.upgrade().filter(|s| !s.finished.get()) else {
            return;
        };
        let elapsed = s.last_progress.get().elapsed();
        if elapsed < IDLE_TIMEOUT {
            idle_timeout(session, IDLE_TIMEOUT.saturating_sub(elapsed));
            return;
        }
        let pending = std::mem::take(&mut *s.pending.borrow_mut());
        for then in pending.into_values() {
            then.fire(Err(OsrError("site_data_timeout".into())));
        }
        finish(&s, Err(OsrError("site_data_timeout".into())));
    });
    cef::post_delayed_task(
        ThreadId::UI,
        Some(&mut Deferred::new(Rc::new(RefCell::new(Some(timeout))))),
        i64::try_from(delay.as_nanos().div_ceil(1_000_000)).unwrap_or(i64::MAX),
    );
}

fn sweep(s: &Rc<Session>, site: Option<String>, next: Next) {
    s.last_progress.set(Instant::now());
    idle_timeout(Rc::downgrade(s), IDLE_TIMEOUT);
    let hosts = Rc::<RefCell<BTreeSet<String>>>::default();
    let origins = s.origins.clone();
    let visited = hosts.clone();
    let all = site.is_none();
    let then = Rc::new(Then {
        next: RefCell::new(Some(Box::new(move |result| {
            if all && result.is_ok() {
                let mut origins = origins.borrow_mut();
                for host in visited.borrow().iter() {
                    for scheme in ["https", "http"] {
                        if let Some(origin) = tuple_origin(&format!("{scheme}://{host}")) {
                            origins.insert(origin);
                        }
                    }
                }
            }
            next(result);
        }))),
        default: None,
    });
    if s.cookies.visit_all_cookies(Some(&mut Sweep::new(
        site,
        hosts,
        s.removed.clone(),
        then.clone(),
    ))) == 0
    {
        then.fire(Err(OsrError("cookies_unavailable".into())));
    }
}

fn cdp(s: &Session, method: &str, params: &str, next: Next) {
    if s.finished.get() {
        return;
    }
    let id = s.next_id.get() + 1;
    s.next_id.set(id);
    s.pending.borrow_mut().insert(id, cancellable(next));
    let message = format!(r#"{{"id":{id},"method":"{method}","params":{params}}}"#);
    if s.host.send_dev_tools_message(Some(message.as_bytes())) != 1 {
        let then = s.pending.borrow_mut().remove(&id);
        if let Some(then) = then {
            then.fire(Err(OsrError("DevTools message rejected".into())));
        }
    }
}

fn json_string(s: &str) -> String {
    let mut quoted = String::with_capacity(s.len() + 2);
    quoted.push('"');
    for ch in s.chars() {
        match ch {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            ch if ch < '\u{20}' => {
                let _ = write!(quoted, "\\u{:04x}", u32::from(ch));
            }
            ch => quoted.push(ch),
        }
    }
    quoted.push('"');
    quoted
}

fn clear_origins(s: &Rc<Session>, mut origins: std::vec::IntoIter<String>, next: Next) {
    let Some(origin) = origins.next() else {
        next(Ok(()));
        return;
    };
    let params = format!(
        r#"{{"origin":{},"storageTypes":"{STORAGE}"}}"#,
        json_string(&origin)
    );
    let session = s.clone();
    cdp(
        s,
        "Storage.clearDataForOrigin",
        &params,
        Box::new(move |result| {
            if session.finished.get() {
                return;
            }
            if let Err(error) = result {
                if matches!(
                    error.0.as_str(),
                    "site_data_cancelled" | "DevTools message rejected" | "site_data_timeout"
                ) {
                    next(Err(error));
                    return;
                }
                session.failed.set(true);
            }
            clear_origins(&session, origins, next);
        }),
    );
}

fn flush(s: &Session, next: Next) {
    s.cookies.flush_store(Some(&mut Completed::new(
        cancellable(next),
        s.last_progress.clone(),
    )));
}

pub(super) fn clear_steps(s: &Rc<Session>) {
    let session = s.clone();
    let flushed: Next = Box::new(move |result| finish(&session, result));
    let session = s.clone();
    let auth_cleared: Next = Box::new(move |result| {
        if result.is_err() {
            return flushed(result);
        }
        if !session.finished.get() {
            flush(&session, flushed);
        }
    });
    let session = s.clone();
    let cache_cleared: Next = Box::new(move |result| {
        if result.is_err() {
            return auth_cleared(result);
        }
        if !session.finished.get() {
            session
                .context
                .clear_http_auth_credentials(Some(&mut Completed::new(
                    cancellable(auth_cleared),
                    session.last_progress.clone(),
                )));
        }
    });
    let session = s.clone();
    let origins_cleared: Next = Box::new(move |result| match result {
        Ok(()) => cdp(&session, "Network.clearBrowserCache", "{}", cache_cleared),
        Err(_) => cache_cleared(result),
    });
    let session = s.clone();
    let swept: Next = Box::new(move |result| {
        if result.is_err() {
            return origins_cleared(result);
        }
        let origins: Vec<_> = session.origins.borrow().iter().cloned().collect();
        clear_origins(&session, origins.into_iter(), origins_cleared);
    });
    sweep(s, None, swept);
}

pub(super) fn sign_out_steps(s: &Rc<Session>, site: String, done: SiteDataDone) {
    let origins = sign_out_origins(&site).into_iter();
    let removed = s.removed.clone();
    *s.completion.borrow_mut() = Some(Box::new(move |result| done(result.map(|()| removed.get()))));
    let session = s.clone();
    let flushed: Next = Box::new(move |result| finish(&session, result));
    let session = s.clone();
    let origins_cleared: Next = Box::new(move |result| {
        if result.is_err() {
            return flushed(result);
        }
        if !session.finished.get() {
            flush(&session, flushed);
        }
    });
    let session = s.clone();
    let swept: Next = Box::new(move |result| match result {
        Ok(()) => clear_origins(&session, origins, origins_cleared),
        Err(_) => origins_cleared(result),
    });
    sweep(s, Some(site), swept);
}
