import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import SqliteDatabase from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { asPlatformAsync } from '../../../helpers/as-platform';

const h = vi.hoisted(() => ({ directory: '', wrappingKey: Buffer.alloc(0) }));

// This fixture models OS wrapping with an independent in-memory key. It never
// accesses a real profile, system Keychain or user credential.
vi.mock('electron', () => ({
  app: { getPath: () => h.directory },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', h.wrappingKey, iv);
      const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString: (bytes: Buffer) => {
      const decipher = createDecipheriv('aes-256-gcm', h.wrappingKey, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  },
}));

afterEach(() => { if (h.directory) rmSync(h.directory, { recursive: true, force: true }); });

describe('legacy mail-key recovery against a real encrypted database', () => {
  it('protects the existing key without changing the database or losing saved mail', async () => {
    await asPlatformAsync('darwin', async () => {
      vi.resetModules();
      h.directory = mkdtempSync(join(tmpdir(), 'inbox-secure-recovery-'));
      h.wrappingKey = randomBytes(32);
      const originalKey = randomBytes(32).toString('hex');
      const keyPath = join(h.directory, 'db-key.bin');
      const databasePath = join(h.directory, 'fixture.db');
      writeFileSync(keyPath, `PLAIN1:${originalKey}`, { mode: 0o600 });

      const before = new SqliteDatabase(databasePath);
      before.pragma(`key='${originalKey}'`);
      before.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT)');
      before.prepare('INSERT INTO messages VALUES (?, ?)').run(1, 'Synthetic meeting invitation');
      before.close();
      const databaseHash = () => createHash('sha256').update(readFileSync(databasePath)).digest('hex');
      const initialHash = databaseHash();
      expect(readFileSync(databasePath).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');

      const first = await import('../../../../electron/services/db-key-store');
      expect(first.getDbEncryptionKey()).toBe(originalKey);
      expect(readFileSync(keyPath).subarray(0, 5).toString()).toBe('ENC1:');
      expect(readFileSync(keyPath).includes(Buffer.from(originalKey))).toBe(false);
      expect(databaseHash()).toBe(initialHash);
      expect(readdirSync(h.directory).sort()).toEqual(['db-key.bin', 'fixture.db']);

      // Simulate a later app launch: read the protected key afresh, then prove
      // the old SQLCipher database and its message still open with that key.
      vi.resetModules();
      const next = await import('../../../../electron/services/db-key-store');
      const recoveredKey = next.getDbEncryptionKey();
      const after = new SqliteDatabase(databasePath, { readonly: true });
      try {
        after.pragma(`key='${recoveredKey}'`);
        expect(after.prepare('SELECT body FROM messages WHERE id = 1').get()).toEqual({ body: 'Synthetic meeting invitation' });
      } finally { after.close(); }
    });
  });
});
