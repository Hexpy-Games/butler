use super::{Config, Record, index::Block, query, retention, storage::Catalog};
use serde_json::json;
use std::{
    collections::BTreeSet,
    fs::File,
    io::{self, BufRead, BufReader, Read, Seek, Write},
    path::{Path, PathBuf},
};
use zip::{ZipWriter, write::SimpleFileOptions};

fn options() -> SimpleFileOptions {
    SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)
}
pub(crate) fn export<W: Write + Seek>(
    output: W,
    root: &Path,
    catalog: &Catalog,
    config: &Config,
    since: Option<&str>,
    until: Option<&str>,
    bodies: bool,
) -> io::Result<W> {
    let since = query::timestamp(since)?;
    let until = query::timestamp(until)?;
    let mut zip = ZipWriter::new(output);
    let mut references = BTreeSet::new();
    for (path, blocks) in catalog {
        if !blocks.iter().any(|b| {
            since.as_ref().is_none_or(|s| b.max_ts >= *s)
                && until.as_ref().is_none_or(|u| b.min_ts <= *u)
        }) {
            continue;
        }
        append_segment(
            &mut zip,
            root,
            path,
            blocks,
            if bodies { Some(&mut references) } else { None },
        )?;
    }
    if bodies {
        for source in ["agent", "app"] {
            for path in retention::files(&root.join(source).join("bodies"))? {
                let name = path.strip_prefix(root).map_err(io::Error::other)?;
                if !references.contains(name) {
                    continue;
                }
                zip.start_file_from_path(name, options())?;
                io::copy(&mut File::open(path)?, &mut zip)?;
            }
        }
    }
    zip.start_file("manifest.json", options())?;
    let manifest = super::redaction::redact_json(
        &json!({"version":1,"os":butler_platform::launcher::node_platform(),"level":config.level,"since":since,"until":until,"include_bodies":bodies}),
    );
    zip.write_all(&serde_json::to_vec(&manifest)?)?;
    Ok(zip.finish()?)
}
fn append_segment<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    root: &Path,
    path: &Path,
    blocks: &[Block],
    references: Option<&mut BTreeSet<PathBuf>>,
) -> io::Result<()> {
    let name = path.strip_prefix(root).map_err(io::Error::other)?;
    let len = blocks.last().map_or(0, |b| b.offset + b.len);
    zip.start_file_from_path(name, options())?;
    io::copy(&mut File::open(path)?.take(len), zip)?;
    zip.start_file_from_path(name.with_extension("idx"), options())?;
    zip.write_all(&serde_json::to_vec(blocks)?)?;
    if let Some(references) = references {
        let source = path
            .strip_prefix(root)
            .map_err(io::Error::other)?
            .components()
            .next()
            .ok_or_else(|| io::Error::other("missing log source"))?
            .as_os_str()
            .to_owned();
        for line in BufReader::new(File::open(path)?.take(len)).lines() {
            let line = line?;
            if let Ok(row) = serde_json::from_str::<Record>(&line)
                && let Some(reference) = row.body_ref
            {
                let file = reference.split(':').next().unwrap_or_default();
                references.insert(Path::new(&source).join("bodies").join(file));
            }
        }
    }
    Ok(())
}
