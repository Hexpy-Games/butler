//! Security contracts for the shared descriptor boundary.
use super::{fs, scratch};
use butler_platform::{secure_fs, secure_fs::SecretInventory};
use std::io::Read;

pub(super) fn verify() {
    let temp = scratch("contained");
    let root = temp.join("project");
    let data = temp.join("data");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(data.join("auth")).unwrap();
    fs::write(root.join("file"), "complete-public").unwrap();
    fs::write(data.join("auth/login"), "private-fixture").unwrap();
    let inventory = SecretInventory::new(&data, &Default::default());
    let pin = inventory.pin_root(&root).unwrap();
    let mut file =
        secure_fs::open_contained(&root, std::path::Path::new("file"), &inventory).unwrap();
    fs::rename(root.join("file"), root.join("before")).unwrap();
    fs::hard_link(data.join("auth/login"), root.join("file")).unwrap();
    let mut text = String::new();
    file.read_to_string(&mut text).unwrap();
    assert_eq!(text, "complete-public");
    assert!(secure_fs::open_contained(&root, std::path::Path::new("file"), &inventory).is_err());
    fs::rename(&root, temp.join("old-project")).unwrap();
    fs::create_dir(&root).unwrap();
    fs::write(root.join("file"), "replacement").unwrap();
    assert!(secure_fs::open_contained(&root, std::path::Path::new("file"), &inventory).is_err());
    drop(pin);
    let _next_turn = inventory.pin_root(&root).unwrap();
    let mut replacement = String::new();
    secure_fs::open_contained(&root, std::path::Path::new("file"), &inventory)
        .unwrap()
        .read_to_string(&mut replacement)
        .unwrap();
    assert_eq!(replacement, "replacement");
    refreshed_cache(&temp);
    retried_inventory(&temp);
    bounded_roots(&temp);
    fs::remove_dir_all(temp).unwrap();
}

fn refreshed_cache(temp: &std::path::Path) {
    let root = temp.join("cached-project");
    let home = temp.join("home");
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::create_dir_all(&home).unwrap();
    fs::write(root.join("sub/file"), "complete-public").unwrap();
    let inventory = SecretInventory::new(
        &temp.join("data"),
        &std::collections::HashMap::from([("HOME".into(), home.to_string_lossy().into_owned())]),
    );
    let cache = secure_fs::ContainedReadCache::default();
    let path = std::path::Path::new("sub/file");
    let mut text = String::new();
    cache
        .open(&root, path, &inventory)
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    assert_eq!(text, "complete-public");
    secure_fs::symlink(&root.join("sub"), &home.join(".ssh")).unwrap();
    inventory.refresh();
    assert!(cache.open(&root, path, &inventory).is_err());
}

fn retried_inventory(temp: &std::path::Path) {
    let root = temp.join("retry-project");
    let data = temp.join("retry-data");
    let locked = data.join("auth/locked");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&locked).unwrap();
    fs::write(locked.join("credential"), "private-fixture").unwrap();
    fs::hard_link(locked.join("credential"), root.join("alias")).unwrap();
    fs::write(root.join("public"), "complete-public").unwrap();
    fs::hard_link(root.join("public"), root.join("public-link")).unwrap();
    let inventory = SecretInventory::new(&data, &Default::default());
    secure_fs::set_file_mode(&locked, secure_fs::FileMode::from_bits(0))
        .unwrap()
        .unwrap();
    let first = secure_fs::open_contained(&root, std::path::Path::new("public-link"), &inventory);
    secure_fs::restrict_directory(&locked).unwrap().unwrap();
    let mut content = String::new();
    first.unwrap().read_to_string(&mut content).unwrap();
    assert_eq!(content, "complete-public");
    assert!(secure_fs::open_contained(&root, std::path::Path::new("alias"), &inventory).is_err());
}

fn bounded_roots(temp: &std::path::Path) {
    let home = temp.join("bounded-home");
    let root = temp.join("bounded-project");
    fs::create_dir_all(&root).unwrap();
    // Both overflowing roots used to exhaust the shared stack budget before
    // the earlier credential roots could contribute any evidence.
    for store in [".kube", ".config/gcloud"] {
        let path = home.join(store);
        fs::create_dir_all(&path).unwrap();
        for n in 0..4096 {
            fs::write(path.join(n.to_string()), "cache").unwrap();
        }
    }
    for (n, store) in [".ssh", ".gnupg", ".aws"].iter().enumerate() {
        let path = home.join(store).join("credential");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "private-fixture").unwrap();
        fs::hard_link(path, root.join(n.to_string())).unwrap();
    }
    let inventory = SecretInventory::new(
        &temp.join("bounded-data"),
        &std::collections::HashMap::from([("HOME".into(), home.to_string_lossy().into_owned())]),
    );
    for n in 0..3 {
        assert!(
            secure_fs::open_contained(&root, std::path::Path::new(&n.to_string()), &inventory)
                .is_err()
        );
    }
}
