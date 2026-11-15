#![allow(
    unsafe_code,
    reason = "Objective-C class definition CEF requires; see SAFETY comments"
)]

use std::cell::Cell;

use cef::application_mac::{CefAppProtocol, CrAppControlProtocol, CrAppProtocol};
use objc2::{
    ClassType, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::{Allocated, Retained},
    runtime::Bool,
};
use objc2_app_kit::{NSApplication, NSEvent};

struct ApplicationIvars {
    handling: Cell<Bool>,
}

define_class!(
    // SAFETY: This main-thread-only NSApplication subclass preserves superclass behavior
    // and supplies the event handling state required by CEF's application protocols.
    #[unsafe(super(NSApplication))]
    #[thread_kind = MainThreadOnly]
    #[name = "ButlerCefApplication"]
    #[ivars = ApplicationIvars]
    struct ButlerCefApplication;

    impl ButlerCefApplication {
        #[unsafe(method_id(init))]
        fn init(this: Allocated<Self>) -> Retained<Self> {
            let this = this.set_ivars(ApplicationIvars {
                handling: Cell::new(Bool::NO),
            });
            // SAFETY: Ivars are initialized before invoking the superclass initializer.
            unsafe { msg_send![super(this), init] }
        }

        #[unsafe(method(sendEvent:))]
        fn send_event(&self, event: &NSEvent) {
            let previous = self.ivars().handling.replace(Bool::YES);
            // SAFETY: The event and receiver are valid and NSApplication runs on the main thread.
            unsafe {
                let _: () = msg_send![super(self), sendEvent: event];
            }
            self.ivars().handling.set(previous);
        }
    }

    // SAFETY: The required selector returns the application's current event handling state.
    unsafe impl CrAppProtocol for ButlerCefApplication {
        #[unsafe(method(isHandlingSendEvent))]
        unsafe fn is_handling_send_event(&self) -> Bool {
            self.ivars().handling.get()
        }
    }

    // SAFETY: The required selector updates the same state exposed by CrAppProtocol.
    unsafe impl CrAppControlProtocol for ButlerCefApplication {
        #[unsafe(method(setHandlingSendEvent:))]
        unsafe fn set_handling_send_event(&self, handling: Bool) {
            self.ivars().handling.set(handling);
        }
    }

    // SAFETY: Both inherited protocols are implemented above; no additional methods are required.
    unsafe impl CefAppProtocol for ButlerCefApplication {}
);

pub(crate) fn install_application() {
    let Some(_main_thread) = MainThreadMarker::new() else {
        return;
    };
    // SAFETY: On the main thread, create the shared application using our NSApplication subclass.
    let _: Retained<ButlerCefApplication> =
        unsafe { msg_send![ButlerCefApplication::class(), sharedApplication] };
}

pub(crate) struct Loaded {
    _loader: cef::library_loader::LibraryLoader,
    _sandbox: Option<cef::sandbox::Sandbox>,
}

pub(crate) fn load(args: &cef::args::Args) -> Result<Loaded, &'static str> {
    let exe = std::env::current_exe().map_err(|_| "cef_framework_unavailable")?;
    let helper = exe
        .file_name()
        .is_some_and(|name| name.to_string_lossy().contains(" Helper"));
    if !helper {
        install_application();
    }
    let loader = cef::library_loader::LibraryLoader::new(&exe, helper);
    if !loader.load() {
        return Err("cef_framework_unavailable");
    }
    let sandbox = if helper {
        let mut sandbox = cef::sandbox::Sandbox::new();
        sandbox.initialize(args.as_main_args());
        Some(sandbox)
    } else {
        None
    };
    Ok(Loaded {
        _loader: loader,
        _sandbox: sandbox,
    })
}
