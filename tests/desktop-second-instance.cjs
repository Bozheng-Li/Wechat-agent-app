const { app } = require('electron');
const path = require('node:path');
const packageRoot = process.env.WECHAT_APP_TEST_PACKAGE_ROOT ? path.resolve(process.env.WECHAT_APP_TEST_PACKAGE_ROOT) : path.resolve(__dirname, '..');
const { runDesktop } = require(path.join(packageRoot, 'desktop/main.cjs'));
app.disableHardwareAcceleration();
let windows = 0;
app.on('browser-window-created', () => windows++);
runDesktop({ instanceHome: process.env.WECHAT_APP_TEST_INSTANCE_HOME }).then(async desktop => {
  const reused = desktop === null && windows === 0;
  if (desktop) await desktop.stop();
  console.log(JSON.stringify({ reused, windows }));
  app.exit(reused ? 0 : 1);
}).catch(error => { console.error(error); app.exit(1); });
