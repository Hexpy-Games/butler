#![allow(clippy::transmute_ptr_to_ptr, reason = "cef-rs wrap macros")]
mod steps;

use super::{
    OsrError, OsrProfile, OsrRuntime, RuntimeState, SiteDataDone,
    site_match::{cookie_matches, origin_of, tuple_origin, valid_site},
};
use cef::*;
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeSet, HashMap},
    rc::{Rc, Weak},
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
};
use steps::{clear_steps, finish, sign_out_steps};

const INTERNAL_PAGE_BASE: u64 = 1 << 62;
static NEXT: AtomicU64 = AtomicU64::new(INTERNAL_PAGE_BASE);
pub(super) fn is_internal(page: u64) -> bool {
    page >= INTERNAL_PAGE_BASE
}

type DeferredRun = Rc<RefCell<Option<Box<dyn FnOnce()>>>>;

wrap_task! {
    struct Deferred { run: DeferredRun }
    impl Task {
        fn execute(&self) {
            let run = self.run.borrow_mut().take();
            if let Some(run) = run {
                run();
            }
        }
    }
}

fn defer(f: impl FnOnce() + 'static) {
    cef::post_task(
        ThreadId::UI,
        Some(&mut Deferred::new(Rc::new(RefCell::new(Some(Box::new(f)))))),
    );
}

type Next = Box<dyn FnOnce(Result<(), OsrError>)>;

struct Then {
    next: RefCell<Option<Next>>,
    default: Option<String>,
}

impl Then {
    fn fire(&self, result: Result<(), OsrError>) {
        let next = self.next.borrow_mut().take();
        if let Some(next) = next {
            defer(move || next(result));
        }
    }
}

impl Drop for Then {
    fn drop(&mut self) {
        let result = self.default.take().map_or(Ok(()), |msg| Err(OsrError(msg)));
        self.fire(result);
    }
}

wrap_completion_callback! {
    struct Completed { then: Rc<Then>, last_progress: Rc<Cell<Instant>> }
    impl CompletionCallback {
        fn on_complete(&self) {
            self.last_progress.set(Instant::now());
            self.then.fire(Ok(()));
        }
    }
}

wrap_cookie_visitor! {
    struct Sweep {
        site: Option<String>,
        hosts: Rc<RefCell<BTreeSet<String>>>,
        removed: Rc<Cell<usize>>,
        then: Rc<Then>,
    }
    impl CookieVisitor {
        fn visit(&self, cookie: Option<&Cookie>, _count: i32, _total: i32, delete: Option<&mut i32>) -> i32 {
            if let (Some(cookie), Some(delete)) = (cookie, delete) {
                let domain = cookie.domain.to_string();
                if self.site.as_ref().is_none_or(|site| cookie_matches(&domain, site)) {
                    *delete = 1;
                    self.removed.set(self.removed.get() + 1);
                    self.hosts.borrow_mut().insert(domain.trim_start_matches('.').to_ascii_lowercase());
                }
            }
            1
        }
    }
}

wrap_dev_tools_message_observer! {
    struct Replies {
        pending: Rc<RefCell<HashMap<i32, Rc<Then>>>>,
        last_progress: Rc<Cell<Instant>>,
    }
    impl DevToolsMessageObserver {
        fn on_dev_tools_method_result(&self, _browser: Option<&mut Browser>, id: i32,
            success: i32, result: Option<&[u8]>) {
            let then = self.pending.borrow_mut().remove(&id);
            if let Some(then) = then {
                self.last_progress.set(Instant::now());
                let result = if success == 1 {
                    Ok(())
                } else {
                    Err(OsrError(String::from_utf8_lossy(result.unwrap_or_default()).into_owned()))
                };
                then.fire(result);
            }
        }
        fn on_dev_tools_agent_detached(&self, _browser: Option<&mut Browser>) {
            let pending = std::mem::take(&mut *self.pending.borrow_mut());
            for then in pending.into_values() {
                then.fire(Err(OsrError("site_data_cancelled".into())));
            }
        }
    }
}

struct Session {
    page: u64,
    host: BrowserHost,
    context: RequestContext,
    cookies: CookieManager,
    pending: Rc<RefCell<HashMap<i32, Rc<Then>>>>,
    next_id: Cell<i32>,
    finished: Cell<bool>,
    failed: Cell<bool>,
    last_progress: Rc<Cell<Instant>>,
    completion: RefCell<Option<Next>>,
    _observer: Registration,
    origins: Rc<RefCell<BTreeSet<String>>>,
    removed: Rc<Cell<usize>>,
    state: Weak<RuntimeState>,
}

impl OsrRuntime {
    fn open_internal(&self, profile: OsrProfile) -> Result<Rc<Session>, OsrError> {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        if let Err(error) = self.open(id, "about:blank", (1, 1), 1., 60, profile) {
            self.close(id);
            return Err(error);
        }
        self.set_visible(id, false);
        let result = (|| {
            let host = self
                .host(id)
                .ok_or_else(|| OsrError("page has no host".into()))?;
            let context = host
                .request_context()
                .ok_or_else(|| OsrError("request context unavailable".into()))?;
            let cookies = context
                .cookie_manager(None)
                .ok_or_else(|| OsrError("cookies_unavailable".into()))?;
            let pending = Rc::new(RefCell::new(HashMap::new()));
            let last_progress = Rc::new(Cell::new(Instant::now()));
            let observer = host
                .add_dev_tools_message_observer(Some(&mut Replies::new(
                    pending.clone(),
                    last_progress.clone(),
                )))
                .ok_or_else(|| OsrError("DevTools observer registration failed".into()))?;
            Ok(Rc::new(Session {
                page: id,
                host,
                context,
                cookies,
                pending,
                next_id: Cell::new(0),
                finished: Cell::new(false),
                failed: Cell::new(false),
                last_progress,
                completion: RefCell::new(None),
                _observer: observer,
                origins: Rc::default(),
                removed: Rc::default(),
                state: Rc::downgrade(&self.state),
            }))
        })();
        if result.is_err() {
            self.close(id);
        }
        result
    }

    fn live_origins(&self, s: &Session) {
        let mut context = s.context.clone();
        for (&id, page) in self.state.pages.borrow().iter() {
            if is_internal(id) {
                continue;
            }
            let Some(browser) = page.borrow().browser.clone() else {
                continue;
            };
            let same = browser
                .host()
                .and_then(|host| host.request_context())
                .is_some_and(|other| other.is_same(Some(&mut context)) == 1);
            if same
                && let Some(frame) = browser.main_frame()
                && let Some(candidate) = origin_of(&CefString::from(&frame.url()).to_string())
                && let Some(origin) = tuple_origin(&candidate)
            {
                s.origins.borrow_mut().insert(origin);
            }
        }
    }

    pub fn clear_site_data(&self, extra: &[String], done: SiteDataDone) {
        let extra: BTreeSet<_> = extra
            .iter()
            .filter_map(|origin| tuple_origin(origin))
            .collect();
        let mut profiles = vec![OsrProfile::SignedIn];
        profiles.extend(
            self.state
                .contexts
                .borrow()
                .keys()
                .cloned()
                .map(OsrProfile::SignedOut),
        );
        let mut sessions = Vec::new();
        for profile in profiles {
            match self.open_internal(profile) {
                Ok(s) => {
                    self.live_origins(&s);
                    s.origins.borrow_mut().extend(extra.iter().cloned());
                    sessions.push(s);
                }
                Err(error) => {
                    for s in sessions {
                        self.close(s.page);
                    }
                    done(Err(error));
                    return;
                }
            }
        }
        run_all(sessions, done);
    }

    pub fn sign_out_site(&self, site: &str, done: SiteDataDone) {
        if !valid_site(site) {
            done(Err(OsrError("invalid_site".into())));
            return;
        }
        let site = site.to_ascii_lowercase();
        match self.open_internal(OsrProfile::SignedIn) {
            Ok(s) => sign_out_steps(&s, site, done),
            Err(error) => done(Err(error)),
        }
    }
}

fn run_all(mut sessions: Vec<Rc<Session>>, done: SiteDataDone) {
    let count = sessions.len();
    let partial = Rc::new(Cell::new(false));
    let reported_partial = partial.clone();
    let mut next: Next = Box::new(move |result| {
        done(result.and_then(|()| {
            if reported_partial.get() {
                Err(OsrError("site_data_partial".into()))
            } else {
                Ok(count)
            }
        }));
    });
    while let Some(s) = sessions.pop() {
        let partial = partial.clone();
        next = Box::new(move |result| {
            *s.completion.borrow_mut() = Some(next);
            match result {
                Ok(()) => clear_steps(&s),
                Err(error) if error.0 == "site_data_partial" => {
                    partial.set(true);
                    clear_steps(&s);
                }
                Err(error) => finish(&s, Err(error)),
            }
        });
    }
    next(Ok(()));
}
