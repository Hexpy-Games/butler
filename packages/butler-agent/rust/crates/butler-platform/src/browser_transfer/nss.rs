//! NSS key4.db PBE and SDR formats, using RustCrypto primitives (no native FFI).
//! Algorithm contracts: nss/lib/softoken/{lowpbe,sftkdb}.c and pk11wrap/pk11sdr.c.
use super::{ImportError, der::Node};
use cbc::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};
use sha1::{Digest, Sha1};
use zeroize::Zeroizing;
const PBES2: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 5, 13];
const PBKDF2: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 5, 12];
const SHA256_HMAC: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 2, 9];
const AES256: &[u8] = &[0x60, 0x86, 0x48, 1, 0x65, 3, 4, 1, 42];
const LEGACY: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 12, 5, 1, 3];
const DES3: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 3, 7];

pub(super) fn pbe(
    encoded: &[u8],
    global: &[u8],
    password: &[u8],
) -> Result<Zeroizing<Vec<u8>>, ImportError> {
    let root = Node::parse(encoded)?;
    let algorithm = root.child(0)?;
    let oid = algorithm.child(0)?.bytes(6)?;
    let params = algorithm.child(1)?;
    let cipher = root.child(1)?.bytes(4)?;
    let mut hash = Sha1::new();
    hash.update(global);
    hash.update(password);
    let password = Zeroizing::new(hash.finalize().to_vec());
    match oid {
        PBES2 => modern(params, cipher, &password),
        LEGACY => legacy(params, cipher, &password),
        _ => Err(ImportError::Format),
    }
}

fn modern(
    params: Node<'_>,
    cipher: &[u8],
    password: &[u8],
) -> Result<Zeroizing<Vec<u8>>, ImportError> {
    let kdf = params.child(0)?;
    if kdf.child(0)?.bytes(6)? != PBKDF2 {
        return Err(ImportError::Format);
    }
    let args = kdf.child(1)?;
    let salt = args.child(0)?.bytes(4)?;
    let iterations = args.child(1)?.integer()?;
    if iterations == 0
        || iterations > 1_000_000
        || args.child(2)?.integer()? != 32
        || args.child(3)?.child(0)?.bytes(6)? != SHA256_HMAC
    {
        return Err(ImportError::Format);
    }
    let enc = params.child(1)?;
    if enc.child(0)?.bytes(6)? != AES256 {
        return Err(ImportError::Format);
    }
    let iv_node = enc.child(1)?;
    let iv = if iv_node.value.len() == 14 {
        iv_node.encoded
    } else {
        iv_node.bytes(4)?
    };
    let mut key = Zeroizing::new([0_u8; 32]);
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(password, salt, iterations, &mut *key);
    let decrypt = cbc::Decryptor::<aes::Aes256>::new_from_slices(&*key, iv)
        .map_err(|_| ImportError::Format)?;
    decrypt
        .decrypt_padded_vec_mut::<Pkcs7>(cipher)
        .map(Zeroizing::new)
        .map_err(|_| ImportError::IncorrectPassword)
}

fn mac(key: &[u8], parts: &[&[u8]]) -> Result<Zeroizing<Vec<u8>>, ImportError> {
    use hmac::{Hmac, Mac};
    let mut mac = Hmac::<Sha1>::new_from_slice(key).map_err(|_| ImportError::Format)?;
    for part in parts {
        mac.update(part);
    }
    Ok(Zeroizing::new(mac.finalize().into_bytes().to_vec()))
}

fn legacy(
    params: Node<'_>,
    cipher: &[u8],
    password: &[u8],
) -> Result<Zeroizing<Vec<u8>>, ImportError> {
    let salt = params.child(0)?.bytes(4)?;
    if salt.len() > 20 || params.child(1)?.integer()? != 1 {
        return Err(ImportError::Format);
    }
    let mut hash = Sha1::new();
    hash.update(password);
    hash.update(salt);
    let hash = Zeroizing::new(hash.finalize().to_vec());
    let mut padded = [0_u8; 20];
    padded
        .get_mut(..salt.len())
        .ok_or(ImportError::Format)?
        .copy_from_slice(salt);
    let mut material = mac(&hash, &[&padded, salt])?;
    let tk = mac(&hash, &[&padded])?;
    material.extend_from_slice(&mac(&hash, &[&tk, salt])?);
    let key = material.get(..24).ok_or(ImportError::Format)?;
    let iv = material
        .get(material.len() - 8..)
        .ok_or(ImportError::Format)?;
    triple_des(key, iv, cipher)
}

fn triple_des(key: &[u8], iv: &[u8], cipher: &[u8]) -> Result<Zeroizing<Vec<u8>>, ImportError> {
    let decrypt = cbc::Decryptor::<des::TdesEde3>::new_from_slices(key, iv)
        .map_err(|_| ImportError::Format)?;
    decrypt
        .decrypt_padded_vec_mut::<Pkcs7>(cipher)
        .map(Zeroizing::new)
        .map_err(|_| ImportError::Format)
}

pub(super) fn login(encoded: &[u8], key: &[u8]) -> Result<Zeroizing<Vec<u8>>, ImportError> {
    let root = Node::parse(encoded)?;
    if root.child(0)?.bytes(4)? != [0xf8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] {
        return Err(ImportError::Format);
    }
    let algorithm = root.child(1)?;
    if algorithm.child(0)?.bytes(6)? != DES3 {
        return Err(ImportError::Format);
    }
    triple_des(key, algorithm.child(1)?.bytes(4)?, root.child(2)?.bytes(4)?)
}
