import { defineConfig } from 'tsup';
import { copyFileSync } from 'fs';
import { join } from 'path';

export default defineConfig({
  entry: ['src/index.ts'],
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
