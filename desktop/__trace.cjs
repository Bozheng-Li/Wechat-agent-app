'use strict';
// Temporary boot trace (not shipped): mirrors desktop/main.cjs startup steps and
// records how far each one gets, so a silent hang can be located.
const { app, BrowserWindow, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const logFile = path.join(__dirname, '..', 'artifacts', 'boot.log');
const started = Date.now();
const log = (message) => fs.appendFileSync(logFile, `+${Date.now() - started}ms ${message}\n`);
fs.writeFileSync(logFile, '');
process.on('unhandledRejection', error => { log('unhandledRejection: ' + (error && error.stack || error)); app.exit(2); });
process.on('uncaughtException', error => { log('uncaughtException: ' + (error && error.stack || error)); app.exit(3); });

(async () => {
  log('entry');
  const singletonHome = path.join(app.getPath('appData'), 'dsh-Wechat-app');
  app.setPath('userData', singletonHome);
  const locked = app.requestSingleInstanceLock();
  log('singleInstanceLock=' + locked);
  if (!locked) { app.quit(); return; }
  const { createDesktopApplication, resolveDataRoot, lockHolder } = await import('../lib/app.js');
  log('imported lib/app.js');
  const data = process.env.WECHAT_APP_HOME ? { root: path.resolve(process.env.WECHAT_APP_HOME), source: 'argument' } : resolveDataRoot(singletonHome);
  log('resolveDataRoot -> ' + data.root + ' (source=' + data.source + ')');
  const root = data.root;
  const holder = lockHolder(root);
  log('lockHolder -> ' + (holder ? JSON.stringify(holder) : 'free'));
  app.setPath('userData', root);
  await app.whenReady();
  log('app ready');
  require('./network.cjs').installNetworkFetch();
  log('network fetch installed');
  const application = await createDesktopApplication({ dataHome: app.getPath('userData'), home: singletonHome, dshHome: process.env.DSH_HOME || path.join(require('node:os').homedir(), '.dsh'), encryption: { isAvailable: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) } });
  log('createDesktopApplication resolved');
  const page = pathToFileURL(path.join(__dirname, '../ui/index.html')).href;
  const window = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  log('window constructed');
  await window.loadURL(page);
  log('page loaded');
  window.show();
  log('window shown');
  setTimeout(() => { log('exiting'); app.exit(0); }, 3000);
})().catch(error => { log('caught: ' + (error && error.stack || error)); app.exit(1); });
