//! Blocking logind signal subscription on a dedicated thread.
pub(super) fn start() {
    if let Err(error) = std::thread::Builder::new()
        .name("system-wake".into())
        .spawn(|| {
            if let Err(error) = watch() {
                eprintln!("[system-wake] logind unavailable: {error}");
            }
        })
    {
        eprintln!("[system-wake] logind thread unavailable: {error}");
    }
}

fn watch() -> zbus::Result<()> {
    let connection = zbus::blocking::Connection::system()?;
    let proxy = zbus::blocking::Proxy::new(
        &connection,
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
    )?;
    for message in proxy.receive_signal("PrepareForSleep")? {
        let (sleeping,): (bool,) = message.body().deserialize()?;
        if !sleeping {
            super::emit();
        }
    }
    Err(zbus::Error::Failure("logind signal stream ended".into()))
}
