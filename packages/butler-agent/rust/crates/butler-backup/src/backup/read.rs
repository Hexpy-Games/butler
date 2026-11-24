use crate::backup::{PIECE, manifest::Kind};
use rusqlite::{Connection, OpenFlags};
use std::{
    io::{self, Read},
    path::Path,
};

pub fn pieces<E: From<io::Error>>(
    path: &Path,
    kind: Kind,
    mut emit: impl FnMut(&[u8]) -> Result<(), E>,
) -> Result<(), E> {
    let mut buffer = vec![0; PIECE];
    match kind {
        Kind::File => {
            let mut file = butler_platform::secure_fs::open_read_no_follow(path)?;
            loop {
                let mut len = 0;
                while len < PIECE {
                    let read = file.read(&mut buffer[len..])?;
                    if read == 0 {
                        break;
                    }
                    len += read;
                }
                if len == 0 {
                    break;
                }
                emit(&buffer[..len])?;
                if len < PIECE {
                    break;
                }
            }
        }
        Kind::Sqlite => {
            let mut db = Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_ONLY
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX
                    | OpenFlags::SQLITE_OPEN_NOFOLLOW,
            )
            .map_err(io::Error::other)?;
            let tx = db.transaction().map_err(io::Error::other)?;
            let mut select = tx
                .prepare("SELECT pgno, data FROM sqlite_dbpage ORDER BY pgno")
                .map_err(io::Error::other)?;
            let mut rows = select.query([]).map_err(io::Error::other)?;
            let mut len = 0;
            while let Some(row) = rows.next().map_err(io::Error::other)? {
                let page = row
                    .get_ref(1)
                    .map_err(io::Error::other)?
                    .as_blob()
                    .map_err(io::Error::other)?;
                buffer[len..len + page.len()].copy_from_slice(page);
                len += page.len();
                if len == PIECE {
                    emit(&buffer)?;
                    len = 0;
                }
            }
            if len != 0 {
                emit(&buffer[..len])?;
            }
        }
    }
    Ok(())
}
