//! Production source boundaries; compiler checks still own complete name resolution.

mod modules;
mod policy;
mod references;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

type Edges = BTreeMap<String, BTreeSet<String>>;

pub(super) fn check(root: &Path) -> Result<bool, String> {
    let entry = root.join("agent/src/lib.rs");
    if !entry.is_file() {
        return Ok(false);
    }
    let modules = modules::load(&entry)?;
    let domains: BTreeSet<_> = modules
        .iter()
        .filter_map(|module| module.path.first().cloned())
        .collect();
    let children: BTreeSet<_> = modules
        .iter()
        .filter(|module| module.path.len() == 2)
        .map(|module| module.path.clone())
        .collect();
    let mut edges = Edges::new();
    let mut errors = BTreeSet::new();
    for domain in &domains {
        if policy::dependencies(domain).is_none() {
            errors.insert(format!("domain {domain} has no reviewed dependency policy"));
        }
    }
    for module in &modules {
        let references = references::References::collect(module);
        let file = module
            .file
            .strip_prefix(root)
            .unwrap_or(&module.file)
            .display();
        for error in references.errors {
            errors.insert(format!("{file}: {error}"));
        }
        let Some(source) = module.path.first() else {
            continue;
        };
        for path in references.paths {
            let Some(target) = path.first() else {
                continue;
            };
            if source == target || !domains.contains(target) {
                continue;
            }
            edges
                .entry(source.clone())
                .or_default()
                .insert(target.clone());
            if !policy::dependencies(source)
                .is_some_and(|allowed| allowed.contains(&target.as_str()))
            {
                errors.insert(format!(
                    "{file}: dependency {source} -> {target} is not allowed"
                ));
            }
            if path.len() > 1 && children.contains(&path[..2]) {
                errors.insert(format!(
                    "{file}: cross-domain child access {}; use the {target} facade",
                    path.join("::")
                ));
            }
        }
    }
    for source in &domains {
        let mut path = vec![source.clone()];
        let mut visited = BTreeSet::new();
        if cycle(source, source, &edges, &mut path, &mut visited) {
            errors.insert(format!("domain dependency cycle: {}", path.join(" -> ")));
        }
    }
    for (source, targets) in &edges {
        println!(
            "DEPENDENCY {source} -> {}",
            targets.iter().cloned().collect::<Vec<_>>().join(", ")
        );
    }
    for error in &errors {
        eprintln!("ARCHITECTURE ERROR {error}");
    }
    println!(
        "ARCHITECTURE modules={} domains={} violations={}",
        modules.len(),
        domains.len(),
        errors.len()
    );
    Ok(!errors.is_empty())
}

fn cycle(
    origin: &str,
    current: &str,
    edges: &Edges,
    path: &mut Vec<String>,
    visited: &mut BTreeSet<String>,
) -> bool {
    if !visited.insert(current.to_owned()) {
        return false;
    }
    if let Some(targets) = edges.get(current) {
        for target in targets {
            path.push(target.clone());
            if target == origin || cycle(origin, target, edges, path, visited) {
                return true;
            }
            path.pop();
        }
    }
    false
}
