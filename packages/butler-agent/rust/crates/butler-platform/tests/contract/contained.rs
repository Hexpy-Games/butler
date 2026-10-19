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
    fs::remove_dir_all(temp).unwrap();
}
