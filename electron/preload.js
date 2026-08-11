// The desktop app's only bridge into the page. It exists for single
// sign-on: that flow has to leave the app for a real browser and come back
// through the OS, which a renderer sandboxed to file:// can't do on its own.
//
// Deliberately narrow. The renderer gets two verbs and a flag, no general
// IPC channel and no Node access -- contextIsolation and sandbox both stay
// on, so anything not listed here is still unreachable from page code.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("outpost", {
  // Lets the web client tell it's running inside the desktop shell rather
  // than a browser tab, which changes how sign-in has to be started.
  isDesktop: true,

  // Opens a URL in the user's real browser. The main process re-checks the
  // scheme; passing anything but http(s) there is refused, so a compromised
  // renderer can't use this to launch arbitrary local handlers.
  openExternal: (url) => ipcRenderer.invoke("open-external", url),

  // Fires when the OS hands the app an outpost://auth?... URL after the
  // browser half of the sign-in finishes. Returns an unsubscribe function
  // so React effects can clean up after themselves.
  onSsoResult: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("sso-result", listener);
    // A sign-in can finish before the renderer has mounted and subscribed
    // (the app may even have been launched by the protocol URL itself), so
    // the main process holds the last result and replays it on request
    // rather than dropping it.
    ipcRenderer.invoke("sso-take-pending").then((pending) => {
      if (pending) callback(pending);
    });
    return () => ipcRenderer.off("sso-result", listener);
  },
});
