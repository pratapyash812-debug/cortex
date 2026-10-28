"""Encryption for the sync folder: AES-256-GCM with a key from a passphrase (scrypt), and the passphrase store.

The passphrase is never written to a Cortex file. It lives in memory, and in the operating system's credential store
(through the `keyring` package) when the user asks to remember it and a store is available.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os

try:
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
    AVAILABLE = True
except ImportError:  # Cortex still runs, and plain (unencrypted) sync still works; start.bat installs the package
    AVAILABLE = False

MAGIC = b"CXS1"
NONCE_BYTES = 12
TAG_BYTES = 16
OVERHEAD = len(MAGIC) + NONCE_BYTES + TAG_BYTES  # bytes sealing adds to the data
MAX_SEAL = 1 << 30  # AES-GCM in memory: larger files are left out of encrypted sync
KDF_N, KDF_R, KDF_P = 1 << 15, 8, 1  # ~32 MiB of memory, a fraction of a second
KDF_N_MIN, KDF_N_MAX = 1 << 10, 1 << 20  # what a sync folder may ask this device to spend on a key
CHECK_TEXT = b"cortex-sync"
KEYRING_SERVICE = "Cortex Sync"


class DecryptError(Exception):
    """The data is damaged, cut short, or sealed with another key."""


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def unb64(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"), validate=True)


def new_params() -> dict:
    """Key derivation settings for a new encrypted vault; the random salt belongs to this vault alone."""
    return {"kdf": "scrypt", "n": KDF_N, "r": KDF_R, "p": KDF_P, "salt": b64(os.urandom(16))}


def valid_params(params) -> bool:
    try:
        return (isinstance(params, dict) and params.get("kdf") == "scrypt" and KDF_N_MIN <= params["n"] <= KDF_N_MAX
                and params["n"] & (params["n"] - 1) == 0 and 1 <= params["r"] <= 16 and 1 <= params["p"] <= 4
                and len(unb64(params["salt"])) >= 16)
    except (KeyError, TypeError, ValueError):
        return False


class Crypto:
    """Seals and opens bytes, and turns a content hash into a file name that reveals nothing about the content."""

    def __init__(self, key: bytes, name_key: bytes):
        self._aead = AESGCM(key)
        self._name_key = name_key

    @classmethod
    def derive(cls, passphrase: str, params: dict) -> Crypto:
        if not AVAILABLE:
            raise DecryptError("encryption needs the 'cryptography' package: run start.bat or Cortex.bat to install it")
        if not valid_params(params):
            raise DecryptError("the key settings in the sync folder are not valid")
        kdf = Scrypt(salt=unb64(params["salt"]), length=64, n=params["n"], r=params["r"], p=params["p"])
        material = kdf.derive(passphrase.encode("utf-8"))
        return cls(material[:32], material[32:])

    def seal(self, data: bytes, aad: bytes) -> bytes:
        if len(data) > MAX_SEAL:
            raise ValueError("too large to encrypt")
        nonce = os.urandom(NONCE_BYTES)
        return MAGIC + nonce + self._aead.encrypt(nonce, data, aad)

    def open(self, blob: bytes, aad: bytes) -> bytes:
        if len(blob) < OVERHEAD or not blob.startswith(MAGIC):
            raise DecryptError("not complete or not encrypted by Cortex")
        nonce = blob[len(MAGIC):len(MAGIC) + NONCE_BYTES]
        try:
            return self._aead.decrypt(nonce, blob[len(MAGIC) + NONCE_BYTES:], aad)
        except InvalidTag as e:
            raise DecryptError("wrong key or damaged data") from e

    def name(self, content_hash: str) -> str:
        return hmac.new(self._name_key, content_hash.encode("ascii"), hashlib.sha256).hexdigest()

    def check_value(self) -> str:
        """A short sealed text stored next to the salt, so a wrong passphrase is recognised before any file is touched."""
        return b64(self.seal(CHECK_TEXT, b"check"))

    def verifies(self, check: str) -> bool:
        try:
            return self.open(unb64(check), b"check") == CHECK_TEXT
        except (DecryptError, ValueError):
            return False


class SecretStore:
    """The remembered passphrases, kept by the operating system through `keyring` when it has a usable store."""

    def __init__(self):
        try:
            import keyring
            from keyring.backends import fail
            backend = keyring.get_keyring()
            self._keyring = None if isinstance(backend, fail.Keyring) or getattr(backend, "priority", 1) <= 0 else keyring
        except Exception:  # noqa: BLE001 - not installed, or no store on this system: the passphrase is asked for instead
            self._keyring = None

    @property
    def available(self) -> bool:
        return self._keyring is not None

    def get(self, vault_id: str) -> str | None:
        if not self._keyring:
            return None
        try:
            return self._keyring.get_password(KEYRING_SERVICE, vault_id)
        except Exception:  # noqa: BLE001
            return None

    def set(self, vault_id: str, secret: str) -> bool:
        if not self._keyring:
            return False
        try:
            self._keyring.set_password(KEYRING_SERVICE, vault_id, secret)
            return True
        except Exception:  # noqa: BLE001
            return False

    def delete(self, vault_id: str) -> None:
        if self._keyring:
            try:
                self._keyring.delete_password(KEYRING_SERVICE, vault_id)
            except Exception:  # noqa: BLE001 - nothing was stored
                pass
