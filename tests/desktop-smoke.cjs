const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { app, safeStorage } = require('electron');
const { runDesktop } = require('../desktop/main.cjs');
app.disableHardwareAcceleration();
// Keep the harness alive while the real window is closed and storage is reopened.
app.on('window-all-closed', () => {});
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const dataHome = fs.mkdtempSync(path.join(artifacts, 'desktop-data-'));
const runId = process.env.WECHAT_APP_TEST_RUN_ID;
const progress = [];
const stage = name => {
  progress.push({ name, at: new Date().toISOString() });
  fs.writeFileSync(path.join(artifacts, 'desktop-progress.json'), JSON.stringify({ runId, dataHome, progress }, null, 2));
  console.log('Desktop: ' + name);
};
const bounded = (operation, label, ms = 15000) => {
  let timer;
  return Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), ms); })]).finally(() => clearTimeout(timer));
};
let desktop, server;
const failures = []; let modelRequests = 0;
process.on('uncaughtException', error => failures.push('Main process: ' + (error.stack || error.message)));
process.on('unhandledRejection', error => failures.push('Main process rejection: ' + String(error?.stack || error)));
const pages = new Set();
const poll = async (test, timeout = 20000) => {
  const started = Date.now();
  while (!(await test())) { if (Date.now() - started > timeout) throw new Error('Desktop condition timed out'); await new Promise(resolve => setTimeout(resolve, 100)); }
};
async function main() {
  stage('starting mock model');
  server = http.createServer((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const value = JSON.parse(body); assert.equal(value.model, 'fixture-model'); modelRequests++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  stage('starting desktop');
  desktop = await bounded(runDesktop({ dataHome, show: true }), 'Desktop startup', 60000); assert.ok(desktop);
  stage('desktop loaded');
  const { window, application } = desktop;
  let repeatedStarts = 0;
  app.on('second-instance', () => repeatedStarts++);
  const repeatLaunch = async (dataDirectory) => {
    const expected = repeatedStarts + 1, env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    if (dataDirectory) env.WECHAT_APP_HOME = dataDirectory;
    else delete env.WECHAT_APP_HOME;
    const child = spawn(process.execPath, [path.join(root, 'tests/desktop-second-instance.cjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { errors += bytes; });
    try {
      const code = await bounded(new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }), 'Repeated startup');
      assert.equal(code, 0, errors || output);
      assert.deepEqual(JSON.parse(output.trim()), { reused: true, windows: 0 });
      await poll(() => repeatedStarts === expected && window.isVisible() && !window.isMinimized());
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
  };
  window.webContents.on('console-message', event => { if (event.level === 'error') failures.push(event.message); });
  const js = code => bounded(window.webContents.executeJavaScript(code), 'Renderer evaluation');
  const capture = async label => {
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    return bounded(window.webContents.capturePage(), label);
  };
  const openPage = async (page, selector = '[data-testid="nav-' + page + '"]') => {
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await poll(() => js(`document.querySelector('.wa-panel')?.dataset.page === ${JSON.stringify(page)} && !!document.querySelector('.wa-page-head h1')`));
    pages.add(page);
  };
  await poll(() => js('!!document.querySelector("[data-testid=nav-settings]")'));
  const initial = await application.call('status'); assert.equal(initial.ok, true); assert.equal(initial.value.startupError, undefined);
  assert.equal(initial.value.online, false); assert.equal(initial.value.runtimeReady, true);
  assert.equal(initial.value.model, null);
  stage('independent startup verified');
  const secondaryHome = path.join(dataHome, 'unused-second-profile');
  window.minimize(); await poll(() => window.isMinimized());
  await repeatLaunch(secondaryHome);
  assert.equal(fs.existsSync(secondaryHome), false, 'another data directory must not initialize a second app');
  stage('different data directory reused the single window');
  stage('waiting for two offline background checks');
  await new Promise(resolve => setTimeout(resolve, 22000));
  assert.equal(failures.length, 0, failures.join('\n'));
  const offline = await application.call('status');
  assert.equal(offline.value.online, false); assert.equal(offline.value.startupError, undefined);
  stage('offline background checks verified');
  await js('document.querySelector("[data-testid=nav-settings]").click()');
  await poll(() => js('[...document.querySelectorAll("button")].some(element => element.textContent.includes("模型设置"))'));
  await js('[...document.querySelectorAll("button")].find(element => element.textContent.includes("模型设置")).click()');
  await poll(() => js('!!document.querySelector("#wa-provider-id")'));
  pages.add('overview'); pages.add('settings'); pages.add('model');
  stage('model settings opened');
  const setInput = (selector, value) => js(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); const prototype=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await setInput('#wa-provider-id', 'fixture'); await setInput('#wa-provider-name', '本地测试服务');
  await setInput('#wa-provider-url', 'http://127.0.0.1:' + server.address().port + '/v1');
  await setInput('#wa-provider-key', 'desktop-fixture-key'); await setInput('#wa-provider-models', 'fixture-model');
  await js('document.querySelector("[data-testid=provider-settings] form").requestSubmit()');
  await poll(() => js('document.body.innerText.includes("模型服务已保存")'));
  assert.equal(await js('document.querySelector("#wa-provider-key").value'), '');
  stage('provider saved');
  await js('[...document.querySelectorAll("button")].find(element=>element.textContent.includes("测试已保存的连接")).click()');
  await poll(() => js('document.body.innerText.includes("模型连接成功")'));
  assert.equal(modelRequests, 1);
  stage('model connection verified');
  // Pasted comma-separated efforts and clearing the field are normal editing operations.
  stage('saving reasoning efforts with whitespace');
  await setInput('[aria-label="fixture-model 推理强度"]', 'low, medium, high');
  stage('reasoning effort input edited');
  await js('document.querySelector("[data-testid=provider-settings] form").requestSubmit()');
  stage('reasoning effort form submitted');
  await poll(() => js('document.body.innerText.includes("模型服务已保存")'));
  assert.deepEqual((await application.call('providers.list')).value.providers[0].models[0].reasoningEfforts, ['low', 'medium', 'high']);
  stage('clearing reasoning efforts');
  await setInput('[aria-label="fixture-model 推理强度"]', '');
  await js('document.querySelector("[data-testid=provider-settings] form").requestSubmit()');
  await poll(() => js('document.body.innerText.includes("模型服务已保存")'));
  assert.deepEqual((await application.call('providers.list')).value.providers[0].models[0].reasoningEfforts, []);
  // This button promises to test the saved configuration, including its model ID.
  stage('testing saved model with an edited draft');
  await setInput('#wa-provider-models', 'unsaved-model');
  await js('[...document.querySelectorAll("button")].find(element=>element.textContent.includes("测试已保存的连接")).click()');
  await poll(() => js('document.body.innerText.includes("模型连接成功")'));
  assert.equal(modelRequests, 2);
  await setInput('#wa-provider-models', 'fixture-model');
  stage('provider editing verified');
  assert.equal(await js('typeof window.require'), 'undefined');
  assert.equal(await js('typeof window.wechatApp.request'), 'function');
  const unsupported = await application.call('desktop.shell', { command: 'noop' }); assert.equal(unsupported.ok, false);
  const providers = await application.call('providers.list'); assert.equal(JSON.stringify(providers).includes('desktop-fixture-key'), false);
  const selected = await application.call('status'); assert.equal(selected.value.defaultModel.model, 'fixture-model');
  const shot = await capture('Model screenshot'); fs.writeFileSync(path.join(artifacts, 'desktop-models.png'), shot.toPNG());
  for (const page of ['authorization', 'records', 'moments', 'traces', 'tasks', 'work', 'digests', 'memory', 'assets', 'settings']) {
    await openPage(page);
    assert.equal(await js('document.documentElement.scrollWidth > window.innerWidth + 1'), false, 'Horizontal overflow on ' + page);
  }
  for (const page of ['persona', 'identity', 'model', 'image-generation', 'automation', 'administrators', 'time', 'storage', 'diagnostics', 'changelog']) {
    await openPage('settings'); await openPage(page, '[data-testid="open-' + page + '"]');
    if (page === 'identity') await poll(() => js('!!document.querySelector("textarea:not(:disabled)")'));
    if (page === 'time') await poll(() => js('!!document.querySelector("[data-testid^=time-group-]")'));
    if (page === 'changelog') await poll(() => js('document.body.innerText.includes("未发布")'));
  }
  stage('all navigation and settings pages verified');
  await openPage('settings'); await openPage('persona', '[data-testid=open-persona]');
  await poll(() => js('!!document.querySelector("#wa-persona-name:not(:disabled)")'));
  await js('document.querySelector("[data-testid=persona-identity-settings]").open = true');
  stage('editing persona name');
  await setInput('#wa-persona-name', '桌面验收助手');
  stage('submitting persona settings');
  await js('document.querySelector("[data-testid=global-persona-editor] form").requestSubmit()');
  await poll(async () => (await application.call('status')).value.persona.name === '桌面验收助手');
  stage('persona settings saved');
  await openPage('settings'); await openPage('model', '[data-testid=open-model]');
  await poll(() => js('!!document.querySelector("#wa-max-tokens:not(:disabled)")'));
  stage('editing model generation settings');
  await setInput('#wa-max-tokens', '2048');
  await js('document.querySelector(".wa-model-parameters").requestSubmit()');
  await poll(async () => (await application.call('status')).value.modelConfig.maxTokens === 2048);
  stage('model generation settings saved');
  await openPage('overview');
  await poll(() => js('document.body.innerText.includes("微信")'));
  fs.writeFileSync(path.join(artifacts, 'desktop-overview.png'), (await capture('Overview screenshot')).toPNG());
  window.setSize(720, 700);
  await poll(() => js('window.innerWidth <= 720'));
  await js('document.querySelector("[data-testid=mobile-navigation]").click()');
  await poll(() => js('document.querySelector("[data-testid=mobile-navigation]").getAttribute("aria-expanded") === "true"'));
  await openPage('settings');
  assert.equal(await js('document.querySelector("[data-testid=mobile-navigation]").getAttribute("aria-expanded")'), 'false');
  assert.equal(await js('document.documentElement.scrollWidth > window.innerWidth + 1'), false, 'Narrow settings must fit the window');
  fs.writeFileSync(path.join(artifacts, 'desktop-narrow.png'), (await capture('Narrow screenshot')).toPNG());
  stage('screenshots captured');
  window.close(); assert.equal(window.isDestroyed(), false, 'window close must retain the tray service');
  await repeatLaunch();
  assert.equal(repeatedStarts, 2);
  stage('repeated normal launch restored the tray window');
  await bounded(desktop.stop(), 'Graceful shutdown'); desktop = null;
  stage('graceful shutdown verified');
  const persisted = JSON.parse(fs.readFileSync(path.join(dataHome, 'providers.json'), 'utf8'));
  assert.equal(persisted.providers[0].models[0].id, 'fixture-model');
  assert.equal(JSON.stringify(persisted).includes('desktop-fixture-key'), false);
  const { createDesktopApplication } = await import('../lib/app.js');
  const restarted = await createDesktopApplication({ dataHome, encryption: {
    isAvailable: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value),
  } });
  try {
    const restored = await restarted.call('status');
    assert.equal(restored.ok, true); assert.equal(restored.value.startupError, undefined);
    assert.equal(restored.value.persona.name, '桌面验收助手');
    assert.equal(restored.value.modelConfig.maxTokens, 2048);
    assert.equal(restored.value.defaultModel.model, 'fixture-model');
    assert.equal((await restarted.call('providers.test', { provider: 'fixture', model: 'fixture-model' })).ok, true);
    assert.equal(modelRequests, 3);
  } finally { await bounded(restarted.close(), 'Restart cleanup'); }
  stage('settings and encrypted credentials survived restart');
  assert.equal(failures.length, 0, failures.join('\n'));
  fs.writeFileSync(path.join(artifacts, 'desktop-smoke.json'), JSON.stringify({ ok: true, runId, finishedAt: new Date().toISOString(), pages: [...pages], modelRequests,
    runtimeReady: true, encryptedCredentials: true, settingsRestored: true, narrowLayout: true, offlineBackground: true, singleInstance: true, repeatedStarts, rendererIsolated: true, realWechatConnected: false, failures }, null, 2));
  console.log('Desktop smoke passed: all pages, provider editing, model API, narrow layout, tray close, graceful shutdown and restart.');
}
main().then(() => { server?.close(); app.exit(0); }).catch(async error => {
  stage('failed: ' + error.message);
  console.error(error);
  if (desktop?.window && !desktop.window.isDestroyed()) {
    const text = await bounded(desktop.window.webContents.executeJavaScript('document.body.innerText'), 'Error snapshot', 2000).catch(() => '');
    fs.writeFileSync(path.join(artifacts, 'desktop-error.txt'), text);
    const image = await bounded(desktop.window.webContents.capturePage(), 'Error screenshot', 2000).catch(() => null);
    if (image) fs.writeFileSync(path.join(artifacts, 'desktop-error.png'), image.toPNG());
  }
  await bounded(Promise.resolve(desktop?.stop()), 'Error cleanup', 5000).catch(() => {}); server?.close(); app.exit(1);
});
