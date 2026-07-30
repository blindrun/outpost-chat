const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");
const { autoUpdater } = require("electron-updater");

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: "#1a140f",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, "web-dist", "index.html"));
}

// Checks GitHub Releases (via the `publish` block in package.json) for a
// newer version, downloads it in the background, and prompts the user to
// restart once it's ready — electron-updater's default
// checkForUpdatesAndNotify() flow, no custom UI needed.
//
// Only meaningful for a real installed copy: electron-updater has nothing
// to replace when run via `electron .` in dev (app.isPackaged is false),
// and errors out immediately if forced there. On macOS specifically, an
// update can be *detected* here even though this app isn't code-signed,
// but Squirrel.Mac (the OS-level updater Electron delegates to) refuses to
// actually *apply* an unsigned update — a real platform requirement, not a
// bug in this wiring. Windows (NSIS) and Linux (AppImage) both update fine
// unsigned.
function initAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.logger = console;
  autoUpdater.on("error", (err) => {
    console.error("[auto-update] error:", err);
  });

  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error("[auto-update] check failed:", err);
  });
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
  initAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
