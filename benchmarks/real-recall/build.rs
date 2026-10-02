//! Stage unchanged private embedding modules with their native module layout.
use std::{fs, path::Path};

fn copy_tree(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let destination = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &destination)?;
        } else {
            fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

fn main() -> std::io::Result<()> {
    let source =
        Path::new("../../packages/butler-agent/rust/crates/butler-agent/src/host/embedding");
    let output = std::env::var_os("OUT_DIR")
        .ok_or_else(|| std::io::Error::other("missing cargo output directory"))?;
    let output = Path::new(&output);
    for module in ["owner", "worker"] {
        copy_tree(&source.join(module), &output.join(module))?;
        fs::copy(
            source.join(format!("{module}.rs")),
            output.join(module).join("mod.rs"),
        )?;
    }
    fs::write(
        output.join("native.rs"),
        "mod owner;\n#[allow(dead_code, unused_imports)]\nmod worker;\n",
    )?;
    println!("cargo:rerun-if-changed={}", source.display());
    Ok(())
}
