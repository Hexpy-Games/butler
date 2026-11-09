//! Whether the machine is online, as Chromium's `navigator.onLine` decides it: some
//! non-loopback interface has an address. Change-driven through the OS interface
//! notifications (`if-watch`); no polling.
use std::future::poll_fn;
use std::sync::OnceLock;
use std::task::Poll;

use if_watch::tokio::IfWatcher;
use tokio::sync::watch;

fn state() -> &'static watch::Sender<bool> {
    // Chromium's default until the OS has answered.
    static STATE: OnceLock<watch::Sender<bool>> = OnceLock::new();
    STATE.get_or_init(|| watch::channel(true).0)
}

/// Subscribe to the online state. The OS watcher starts once, on first use. When the OS gives no
/// watcher, one diagnostic is printed and the value stays `true`.
pub fn online() -> watch::Receiver<bool> {
    static START: std::sync::Once = std::sync::Once::new();
    let receiver = state().subscribe();
    START.call_once(|| {
        if let Err(error) = std::thread::Builder::new()
            .name("network-status".into())
            .spawn(|| {
                if let Err(error) = watch_interfaces() {
                    eprintln!("[network-status] interface watcher unavailable: {error}");
                }
            })
        {
            eprintln!("[network-status] watcher thread unavailable: {error}");
        }
    });
    receiver
}

fn watch_interfaces() -> std::io::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        let mut watcher = IfWatcher::new()?;
        // The OS reports the addresses that already exist as events first; the value is
        // published once they are drained, then after every change.
        let mut settled = false;
        loop {
            let event = poll_fn(|cx| match watcher.poll_if_event(cx) {
                Poll::Pending if !settled => Poll::Ready(None),
                Poll::Pending => Poll::Pending,
                Poll::Ready(event) => Poll::Ready(Some(event)),
            })
            .await;
            match event {
                None => settled = true,
                Some(Err(error)) => return Err(error),
                Some(Ok(_)) => {}
            }
            if settled {
                let online = watcher.iter().any(|net| !net.addr().is_loopback());
                state().send_if_modified(|value| std::mem::replace(value, online) != online);
            }
        }
    })
}
