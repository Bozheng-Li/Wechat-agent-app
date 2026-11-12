const { app, net } = require('electron');

// Electron's network stack follows the user's Windows proxy and certificate
// settings. Node's fetch bypasses those settings and can fail on the same API.
function installNetworkFetch() {
  if (!app.isReady()) throw new Error('Initialize desktop networking after app.whenReady()');
  globalThis.fetch = (input, options = {}) => net.fetch(input, {
    ...options, credentials: 'omit', cache: 'no-store',
  });
}

module.exports = { installNetworkFetch };
