# OpenPGP interop fixtures

Every key here is a **throwaway test key** with no passphrase, made only for
these tests. None of them protects anything.

- `recipient.key.asc` / `recipient.pub.asc`: "Rita Recipient
  <rita@example.com>", generated with openpgp.js (v4 Curve25519).
- `gpg-sender.pub.asc`: "Gee Pee <gee@example.org>", generated with **GnuPG
  2.4.7** (ed25519 plus a cv25519 subkey). Its private half was thrown away.
- `gpg-*.eml`, `gpg-*.txt`, `gpg-*.asc`: messages made by GnuPG, signed by Gee
  Pee and encrypted to Rita where encrypted. These show that mail from an
  independent implementation opens here, not just mail we made ourselves.

The files are marked `-text` in `.gitattributes`. The signatures cover their
exact bytes, CRLFs included.
