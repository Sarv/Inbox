#!/usr/bin/env node

// Only a development/build dependency. Shipped apps already contain a signed,
// architecture-matched helper and never compile code on the user's computer.
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

if (process.platform === 'darwin') {
  const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
  const { buildKeychainHelper } = require('./build/keychain-helper.js');
  const electronExecutable = require('electron');
  await buildKeychainHelper({ directory: dirname(electronExecutable), arch: process.arch });
}
