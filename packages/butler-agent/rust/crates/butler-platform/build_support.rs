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
