const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
if (!process.argv.includes('--from-plugin')) throw new Error('Live testing requires --from-plugin');
app.disableHardwareAcceleration();
const testParent = path.resolve(__dirname, '../storage/live-tests');
fs.mkdirSync(testParent, { recursive: true });
const reused = process.argv.find(value => value.startsWith('--reuse-profile='))?.slice(16);
let dataRoot;
if (reused) {
  const profile = fs.realpathSync(reused);
  dataRoot = path.dirname(profile);
  if (path.basename(profile) !== 'profile' || path.dirname(dataRoot) !== fs.realpathSync(testParent) || !/^live-[a-zA-Z0-9]+$/.test(path.basename(dataRoot))) throw new Error('Only an isolated live-test profile can be reused');
} else dataRoot = fs.mkdtempSync(path.join(testParent, 'live-'));
app.setPath('userData', path.join(dataRoot, 'desktop'));
app.whenReady().then(async () => {
  require('../desktop/network.cjs').installNetworkFetch();
  const { runLiveCases } = await import('./live-app-cases.mjs');
  const passed = await runLiveCases({ dataRoot, encryption: {
    isAvailable: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value),
  }, reuseImage: !!reused, only: process.argv.find(value => value.startsWith('--only='))?.slice(7).split(',') });
  app.exit(passed ? 0 : 1);
}).catch(error => { console.error(error.stack); app.exit(1); });
