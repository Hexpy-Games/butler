// Link the CEF framework at launch in every process (the helpers are copies of this binary).
// Launch-time images get their fixups applied at page-in, so the framework's relocated pages
// stay clean and shared; dlopen() alone dirties them in each process. cef-rs's loader still
// dlopen()s the same path and gets the already-loaded image.
fn main() {
    println!("cargo::rerun-if-env-changed=CEF_PATH");
    let cef = std::env::var("CEF_PATH").expect("CEF_PATH points at the CEF distribution");
    println!("cargo::rustc-link-search=framework={cef}");
    println!("cargo::rustc-link-arg=-Wl,-needed_framework,Chromium Embedded Framework");
}
