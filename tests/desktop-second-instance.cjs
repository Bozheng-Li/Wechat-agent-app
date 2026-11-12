const { app } = require('electron');
const { runDesktop } = require('../desktop/main.cjs');
app.disableHardwareAcceleration();
let windows = 0;
app.on('browser-window-created', () => windows++);
runDesktop().then(async desktop => {
  const reused = desktop === null && windows === 0;
  if (desktop) await desktop.stop();
  console.log(JSON.stringify({ reused, windows }));
  app.exit(reused ? 0 : 1);
}).catch(error => { console.error(error); app.exit(1); });
