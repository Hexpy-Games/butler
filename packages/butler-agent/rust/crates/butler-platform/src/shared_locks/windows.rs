use std::{
    fs::{self, File, OpenOptions},
    io,
};

pub(super) fn open(namespace: &str, name: &str) -> io::Result<File> {
    let root = std::env::temp_dir().join(namespace);
    fs::create_dir_all(&root)?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(name))
}
