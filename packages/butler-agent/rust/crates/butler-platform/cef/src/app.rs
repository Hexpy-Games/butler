//! The browser process: Chrome's headless mode (no OS window), off-the-record default pages, and
//! a default client so browsers that CDP creates are managed.
// cef-rs's `wrap_*!` expansions transmute between their own reference types.
#![allow(
    clippy::transmute_ptr_to_ptr,
    reason = "inside the cef-rs wrap_*! expansions"
)]
use cef::*;

// Downloads are allowed and left to Chrome's own handling, which follows the DevTools
// `Browser.setDownloadBehavior` the executor sets; CEF cancels them without a handler.
cef::wrap_download_handler! {
    pub struct HostDownloads {}

    impl DownloadHandler {
        fn can_download(
            &self,
            _browser: Option<&mut Browser>,
            _url: Option<&CefString>,
            _request_method: Option<&CefString>,
        ) -> ::std::os::raw::c_int {
            1
        }
    }
}

cef::wrap_client! {
    pub struct HostClient {
        downloads: DownloadHandler,
    }

    impl Client {
        fn download_handler(&self) -> Option<DownloadHandler> {
            Some(self.downloads.clone())
        }
    }
}

cef::wrap_browser_process_handler! {
    pub struct HostProcess {}

    impl BrowserProcessHandler {
        // Browsers created through DevTools (`Target.createTarget`, `window.open`) get this
        // client; without one CEF leaves them unmanaged.
        fn default_client(&self) -> Option<Client> {
            Some(HostClient::new(HostDownloads::new()))
        }
    }
}

cef::wrap_app! {
    pub struct HostApp {}

    impl App {
        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(HostProcess::new())
        }

        fn on_before_command_line_processing(
            &self,
            process_type: Option<&CefString>,
            command_line: Option<&mut CommandLine>,
        ) {
            // Helpers (`--type=…`) inherit what they need from the browser process.
            if process_type.is_none_or(|value| value.to_string().is_empty())
                && let Some(command_line) = command_line
            {
                command_line.append_switch(Some(&CefString::from("headless")));
            }
        }
    }
}
