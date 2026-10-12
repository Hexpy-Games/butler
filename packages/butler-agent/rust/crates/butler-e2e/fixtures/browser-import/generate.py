"""Deterministic NSS format fixtures; requires only Python and OpenSSL."""
import base64
import hashlib
import hmac
import json
from pathlib import Path
import sqlite3
import subprocess

ROOT = Path(__file__).resolve().parent
DES3 = bytes.fromhex('2a864886f70d0307')
AES256 = bytes.fromhex('60864801650304012a')
LEGACY = bytes.fromhex('2a864886f70d010c050103')
PBES2 = bytes.fromhex('2a864886f70d01050d')
PBKDF2 = bytes.fromhex('2a864886f70d01050c')
SHA256 = bytes.fromhex('2a864886f70d0209')
KEY_ID = bytes.fromhex('f8000000000000000000000000000001')


def node(tag, value):
    size = len(value)
    length = bytes([size]) if size < 128 else bytes([0x81, size])
    return bytes([tag]) + length + value


def seq(*values):
    return node(0x30, b''.join(values))


def encrypt(mode, key, iv, text):
    result = subprocess.run(['openssl', 'enc', '-' + mode, '-K', key.hex(),
                             '-iv', iv.hex()], input=text, capture_output=True, check=True)
    return result.stdout


def pbe(text, modern):
    password = hashlib.sha1(b'global-fixture' + b'fixture-primary').digest()
    salt = b'entry-fixture'
    if modern:
        key = hashlib.pbkdf2_hmac('sha256', password, salt, 2, 32)
        iv = bytes(range(16))
        params = seq(seq(node(6, PBKDF2), seq(node(4, salt), node(2, b'\x02'),
                     node(2, b'\x20'), seq(node(6, SHA256), node(5, b'')))),
                     seq(node(6, AES256), node(4, iv)))
        return seq(seq(node(6, PBES2), params), node(4, encrypt('aes-256-cbc', key, iv, text)))
    digest = hashlib.sha1(password + salt).digest()
    padded = salt.ljust(20, b'\0')
    mac = lambda value: hmac.new(digest, value, hashlib.sha1).digest()
    material = mac(padded + salt) + mac(mac(padded) + salt)
    params = seq(node(4, salt), node(2, b'\x01'))
    return seq(seq(node(6, LEGACY), params),
               node(4, encrypt('des-ede3-cbc', material[:24], material[-8:], text)))


def generate(name, modern):
    folder = ROOT / name
    folder.mkdir(exist_ok=True)
    path = folder / 'key4.db'
    path.unlink(missing_ok=True)
    key = bytes(range(32 if modern else 24))
    with sqlite3.connect(path) as db:
        db.execute('CREATE TABLE metadata(id TEXT,item1 BLOB,item2 BLOB)')
        db.execute('CREATE TABLE nssPrivate(a102 BLOB,a11 BLOB)')
        db.execute('INSERT INTO metadata VALUES(?,?,?)',
                   ('password', b'global-fixture', pbe(b'password-check', modern)))
        db.execute('INSERT INTO nssPrivate VALUES(?,?)', (KEY_ID, pbe(key, modern)))
    iv = bytes(range(16 if modern else 8))
    def login(text):
        data = seq(node(4, KEY_ID), seq(node(6, AES256 if modern else DES3), node(4, iv)),
                   node(4, encrypt('aes-256-cbc' if modern else 'des-ede3-cbc', key, iv, text)))
        return base64.b64encode(data).decode()
    row = {'hostname': 'https://login.fixture-import.test',
           'encryptedUsername': login(b'fixture-user'),
           'encryptedPassword': login(b'canary-native-723ac8'),
           'timeLastUsed': 1700000000000, 'timePasswordChanged': 1700000000000}
    (folder / 'logins.json').write_text(json.dumps({'logins': [row]}) + '\n')


if __name__ == '__main__':
    generate('firefox-legacy', False)
    generate('firefox-aes', True)
