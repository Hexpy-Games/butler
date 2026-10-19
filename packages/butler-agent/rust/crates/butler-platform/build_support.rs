//! Build-time platform policy, shared with the agent build script.

pub(super) fn embed_application_manifest() -> Result<(), embed_manifest::Error> {
    println!("cargo:rerun-if-changed=../butler-platform/build_support.rs");
    println!("cargo:rerun-if-env-changed=CARGO_CFG_WINDOWS");
    if std::env::var_os("CARGO_CFG_WINDOWS").is_some() {
        let manifest = embed_manifest::new_manifest("Butler.Agent")
            .long_path_aware(embed_manifest::manifest::Setting::Enabled);
        embed_manifest::embed_manifest(manifest)?;
    }
    Ok(())
}

/// Store ELF relative relocations compactly instead of paging in full RELA records.
/// GNU ld supports this encoding on x86 GNU/Linux; other targets keep their format.
pub(super) fn pack_relative_relocations() {
    for name in [
        "CARGO_CFG_TARGET_OS",
        "CARGO_CFG_TARGET_ENV",
        "CARGO_CFG_TARGET_ARCH",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu")
        && matches!(
            std::env::var("CARGO_CFG_TARGET_ARCH").as_deref(),
            Ok("x86" | "x86_64")
        )
    {
        println!("cargo:rustc-link-arg=-Wl,-z,pack-relative-relocs");
    }
}
