const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: "#1e1f22",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, "web-dist", "index.html"));
}

app.whenReady().then(() => {
  // Required for LiveKit voice/video to work at all — a packaged Electron
  // app silently denies getUserMedia (mic/camera) unless the main process
  // explicitly grants it here. Without this, voice chat fails exactly like
  // a browser with the permission blocked, with no obvious error surfaced
  // to the user.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
