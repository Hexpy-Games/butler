pub(crate) struct Loaded {
    _loader: cef::library_loader::LibraryLoader,
    _sandbox: Option<cef::sandbox::Sandbox>,
}

pub(crate) fn load(args: &cef::args::Args) -> Result<Loaded, &'static str> {
    let exe = std::env::current_exe().map_err(|_| "cef_framework_unavailable")?;
    let helper = exe
        .file_name()
        .is_some_and(|name| name.to_string_lossy().contains(" Helper"));
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
