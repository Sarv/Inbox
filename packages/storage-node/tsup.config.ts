import { defineConfig } from 'tsup';
import { copyFileSync } from 'fs';
import { join } from 'path';

export default defineConfig({
  // `db-encryption` is a SECOND entry point on purpose: the VACUUM worker and the
  // core DB key their connections through it, and it imports nothing but `fs`.
  // The barrel would pull all of SQLiteStorage (and @sarvinbox/core) onto the
  // worker thread for one helper.
  entry: ['src/index.ts', 'src/db-encryption.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ['@sarvinbox/core', 'better-sqlite3'],
  onSuccess: async () => {
    // Copy schema.sql to dist
    copyFileSync(
      join(__dirname, 'src/schema.sql'),
      join(__dirname, 'dist/schema.sql')
    );
  },
});
