//! Count each attempted filesystem operation, preserving std::fs semantics.
use std::{fs, io, path::Path};

macro_rules! unary {
    ($name:ident, $result:ty) => {
        pub(crate) fn $name(path: impl AsRef<Path>) -> io::Result<$result> {
            super::operation();
            fs::$name(path)
        }
    };
}
unary!(read, Vec<u8>);
unary!(read_to_string, String);
unary!(create_dir_all, ());
unary!(remove_dir_all, ());
unary!(remove_file, ());
unary!(symlink_metadata, fs::Metadata);
unary!(metadata, fs::Metadata);

pub(crate) fn exists(path: impl AsRef<Path>) -> bool {
    super::operation();
    path.as_ref().exists()
}
pub(crate) fn write(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()> {
    super::operation();
    fs::write(path, contents)
}
macro_rules! binary {
    ($name:ident, $result:ty) => {
        pub(crate) fn $name(from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<$result> {
            super::operation();
            fs::$name(from, to)
        }
    };
}
binary!(copy, u64);
binary!(rename, ());
binary!(hard_link, ());

pub(crate) struct ReadDir(fs::ReadDir);
pub(crate) struct DirEntry(fs::DirEntry);
pub(crate) fn read_dir(path: impl AsRef<Path>) -> io::Result<ReadDir> {
    super::operation();
    fs::read_dir(path).map(ReadDir)
}
impl Iterator for ReadDir {
    type Item = io::Result<DirEntry>;
    fn next(&mut self) -> Option<Self::Item> {
        self.0.next().map(|entry| {
            super::operation();
            entry.map(DirEntry)
        })
    }
}
impl DirEntry {
    pub(crate) fn file_type(&self) -> io::Result<fs::FileType> {
        super::operation();
        self.0.file_type()
    }
    pub(crate) fn path(&self) -> std::path::PathBuf {
        self.0.path()
    }
    pub(crate) fn file_name(&self) -> std::ffi::OsString {
        self.0.file_name()
    }
}

pub(crate) fn canonicalize(path: impl AsRef<Path>) -> io::Result<std::path::PathBuf> {
    super::operation();
    butler_platform::secure_fs::canonicalize(path)
}
pub(crate) fn restrict_directory(path: &Path) -> Option<io::Result<()>> {
    super::operation();
    butler_platform::secure_fs::restrict_directory(path)
}
pub(crate) fn restrict_file(path: &Path) -> Option<io::Result<()>> {
    super::operation();
    butler_platform::secure_fs::restrict_file(path)
}
