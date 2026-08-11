const { app, BrowserWindow, desktopCapturer, session, Menu, dialog, shell, ipcMain } = require("electron");
const path = require("node:path");
const { autoUpdater } = require("electron-updater");

let mainWindow = null;
let updateDownloaded = false;
// Holds an SSO result that arrived before the renderer was listening --
// including the case where the protocol URL is what launched the app in the
// first place. Replayed via the "sso-take-pending" handler, then cleared so
// a stale code can't be redeemed twice.
let pendingSsoResult = null;

const PROTOCOL = "outpost";

// Turns the OS's outpost://auth?oidc=... hand-off into something the
// renderer understands. Returns null for anything that isn't ours, since
// argv on Windows/Linux is full of things that aren't this URL.
function parseSsoUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith(`${PROTOCOL}://`)) return null;
  try {
    const url = new URL(rawUrl);
    const code = url.searchParams.get("oidc");
    const error = url.searchParams.get("oidc_error");
    if (!code && !error) return null;
    return { code, error };
  } catch {
    return null;
  }
}

function deliverSsoResult(rawUrl) {
  const result = parseSsoUrl(rawUrl);
  if (!result) return;
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send("sso-result", result);
    // Still buffered: the window can exist while the React tree that
    // subscribes hasn't mounted yet, and a dropped code means the user
    // silently ends up back at a login screen having just signed in.
    pendingSsoResult = result;
  } else {
    pendingSsoResult = result;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
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
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile(path.join(__dirname, "web-dist", "index.html"));
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "About Outpost",
    message: "Outpost",
    detail: `Version ${app.getVersion()}\n\nSelf-hosted Discord alternative.\nhttps://github.com/blindrun/outpost-chat`,
    buttons: ["OK"],
  });
}

function promptRestartToUpdate() {
  dialog
    .showMessageBox(mainWindow, {
      type: "info",
      title: "Update Ready",
      message: "A new version of Outpost has been downloaded.",
      detail: "Restart now to apply it, or keep working — it'll apply automatically next time you quit.",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
      cancelId: 1,
    })
    .then((result) => {
      if (result.response === 0) autoUpdater.quitAndInstall();
    });
}

// Manual "Check for Updates" menu action. Separate from the silent
// startup check below — this one always gives feedback (checking,
// up to date, error), since a user who explicitly clicked it is owed an
// answer either way, not just silence unless something happened to be
// available.
function checkForUpdatesManually() {
  if (!app.isPackaged) {
    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Check for Updates",
      message: "Updates are only checked in a packaged build, not this dev copy.",
    });
    return;
  }

  if (updateDownloaded) {
    promptRestartToUpdate();
    return;
  }

  const onAvailable = () => {
    cleanup();
    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Update Found",
      message: "A new version is downloading in the background — you'll be prompted to restart once it's ready.",
    });
  };
  const onNotAvailable = () => {
    cleanup();
    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Up to Date",
      message: `Outpost ${app.getVersion()} is the latest version.`,
    });
  };
  const onError = (err) => {
    cleanup();
    dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "Update Check Failed",
      message: err.message ?? String(err),
    });
  };
  function cleanup() {
    autoUpdater.removeListener("update-available", onAvailable);
    autoUpdater.removeListener("update-not-available", onNotAvailable);
    autoUpdater.removeListener("error", onError);
  }
  autoUpdater.once("update-available", onAvailable);
  autoUpdater.once("update-not-available", onNotAvailable);
  autoUpdater.once("error", onError);

  autoUpdater.checkForUpdates().catch(onError);
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const appMenu = {
    label: "Outpost",
    submenu: [
      { label: "About Outpost", click: showAbout },
      { label: "Check for Updates…", click: checkForUpdatesManually },
      { type: "separator" },
      ...(isMac ? [{ role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }] : []),
      { role: "quit" },
    ],
  };

  const template = [
    appMenu,
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      label: "Help",
      submenu: [
        {
          label: "View on GitHub",
          click: () => shell.openExternal("https://github.com/blindrun/outpost-chat"),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Silent startup check: downloads a new version in the background with no
// interruption unless one is actually found, at which point the shared
// update-downloaded listener below prompts a restart — the same dialog the
// manual "Check for Updates" path ends at, so there's one place that
// actually offers to apply an update, not a passive OS notification with
// no working action behind it (that's what checkForUpdatesAndNotify() did
// before, and clicking it did nothing on Linux).
//
// Only meaningful for a real installed copy: electron-updater has nothing
// to replace when run via `electron .` in dev. On macOS specifically, an
// update can be *detected* even though this app isn't code-signed, but
// Squirrel.Mac (the OS-level updater Electron delegates to) refuses to
// actually *apply* an unsigned update — a real platform requirement, not a
// bug in this wiring. Windows (NSIS) and Linux (AppImage) both update fine
// unsigned.
function initAutoUpdater() {
  autoUpdater.logger = console;
  autoUpdater.on("update-downloaded", () => {
    updateDownloaded = true;
    promptRestartToUpdate();
  });
  autoUpdater.on("error", (err) => {
    console.error("[auto-update] error:", err);
  });

  if (!app.isPackaged) return;
  autoUpdater.checkForUpdates().catch((err) => {
    console.error("[auto-update] check failed:", err);
  });
}

// Registers this build as the handler for outpost:// URLs. In a packaged
// app the installer's own registration is what matters on Windows and
// Linux, but this call is still what makes it work when running unpackaged,
// and is harmless (idempotent) otherwise. The dev branch has to name the
// script explicitly, since the executable there is Electron itself.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// Without the single-instance lock, opening outpost://... would launch a
// SECOND copy of the app holding the sign-in result, while the window the
// user was actually looking at sits there still logged out.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  // Windows and Linux deliver the URL as an argv entry on the new instance,
  // which this (the original instance) receives here.
  app.on("second-instance", (_event, argv) => {
    for (const arg of argv) deliverSsoResult(arg);
  });
  // macOS delivers it as an event instead, to the running instance.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    deliverSsoResult(url);
  });
  // Cold start: the protocol URL is what launched the app, so it's sitting
  // in this process's own argv rather than arriving as an event.
  for (const arg of process.argv) deliverSsoResult(arg);
}

ipcMain.handle("open-external", (_event, url) => {
  // Re-checked here rather than trusted from the renderer: shell.openExternal
  // will hand a url: to whatever the OS has registered for it, so anything
  // but http(s) is refused outright.
  if (typeof url !== "string") return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  shell.openExternal(url);
  return true;
});

ipcMain.handle("sso-take-pending", () => {
  const pending = pendingSsoResult;
  pendingSsoResult = null;
  return pending;
});

app.whenReady().then(() => {
  // Required for LiveKit voice/video to work at all — a packaged Electron
  // app silently denies getUserMedia (mic/camera) unless the main process
  // explicitly grants it here. Without this, voice chat fails exactly like
  // a browser with the permission blocked, with no obvious error surfaced
  // to the user.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });

  // Screen sharing needs its own handler on top of the permission one above.
  // Electron has required this since v17: with no display-media handler
  // registered, `getDisplayMedia` is denied outright and rejects with a
  // NotAllowedError — indistinguishable from the user cancelling a picker.
  // That's why screen share appeared to be "not supported" in the desktop
  // app on every platform while working fine in a browser, where the browser
  // owns the picker.
  //
  // `useSystemPicker` is the right answer wherever it's available: on Wayland
  // it hands off to the desktop's own xdg-desktop-portal picker (the only way
  // to capture anything on Wayland at all), and on macOS to ScreenCaptureKit.
  // Where it isn't supported, Electron calls the handler below instead.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen", "window"] })
        .then((sources) => {
          // No in-app source picker yet, so this falls back to the primary
          // screen. Acceptable because getDisplayMedia only ever runs from an
          // explicit "share screen" click — but choosing a specific window is
          // a real gap worth closing separately.
          const screen = sources.find((s) => s.id.startsWith("screen:")) ?? sources[0];
          if (!screen) {
            console.error("[screen-share] no capturable sources returned");
            // Electron requires the callback either way; an empty object
            // rejects the request cleanly rather than hanging the promise.
            callback({});
            return;
          }
          // System-audio capture via "loopback" is Windows-only in Electron;
          // passing it on Linux/macOS isn't supported, so share video alone
          // there rather than risk the whole request being refused.
          callback(process.platform === "win32" ? { video: screen, audio: "loopback" } : { video: screen });
        })
        .catch((err) => {
          console.error("[screen-share] enumerating sources failed:", err);
          callback({});
        });
    },
    { useSystemPicker: true },
  );

  buildMenu();
  createWindow();
  initAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
