//! The staged Linux host finds `libcef.so` beside itself: stage.py copies CEF's runtime files next
//! to the binary, and the agent starts it without `LD_LIBRARY_PATH`.
fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo::rustc-link-arg-bins=-Wl,-rpath,$ORIGIN");
    }
}
