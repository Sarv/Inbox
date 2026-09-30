# OpenPGP interop fixtures

Every key here is a **throwaway test key** with no passphrase, made only for
these tests. None of them protects anything. The recipient private key is
committed solely so GnuPG ciphertext can be decrypted in interoperability tests;
never use these keys for real mail.

- `recipient.key.asc` / `recipient.pub.asc`: "Rita Recipient
  <rita@example.com>", generated with GnuPG 2.5.18 (Ed25519 primary and
  Curve25519 encryption subkey).
- `gpg-sender.pub.asc`: "Gee Pee <gee@example.org>", generated with **GnuPG
  2.5.18** (Ed25519 signing key). Its private half was thrown away.
- `gpg-*.eml`, `gpg-*.txt`, `gpg-*.asc`: messages made by GnuPG, signed by Gee
  Pee and encrypted to Rita where encrypted. These show that mail from an
  independent implementation opens here, not just mail we made ourselves.

The files are marked `-text` in `.gitattributes`. The signatures cover their
exact bytes, CRLFs included.
