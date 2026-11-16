//! The packaged shell finds `libcef.so` beside itself: the package lays the CEF runtime out next to
//! the executable, and the shell starts without `LD_LIBRARY_PATH`.
fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux")
        && std::env::var_os("CARGO_FEATURE_CEF").is_some()
    {
        println!("cargo::rustc-link-arg-bins=-Wl,-rpath,$ORIGIN");
    }
}
