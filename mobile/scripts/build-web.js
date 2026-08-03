// Builds the shared web client for the Capacitor wrapper (both the Android
// and iOS platforms sync from this same output) and writes it into
// web-dist/, matching electron/scripts/build-web.js's dual-build reasoning:
// this is a separate build from the one shipped in the Docker image (real
// HTTP origin, absolute asset paths). Capacitor serves the bundled assets
// through its own WebView asset loader rather than a real HTTP origin, and
// relative paths (`./assets/x.js`) are the one encoding guaranteed to
// resolve correctly regardless of the exact serving scheme it uses — same
// choice Electron's file:// build already made.
const { execFileSync } = require("node:child_process");
const { rmSync } = require("node:fs");
const path = require("node:path");

const webDir = path.join(__dirname, "..", "..", "web");
const outDir = path.join(__dirname, "..", "web-dist");

rmSync(outDir, { recursive: true, force: true });

// On Windows, npx resolves to npx.cmd, a batch file that CreateProcess
// can't launch directly (execFileSync throws EINVAL) — it has to go
// through a shell. Same gotcha electron's build-web.js already hit.
const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
const shell = process.platform === "win32";
execFileSync(npxCmd, ["tsc", "-b"], { cwd: webDir, stdio: "inherit", shell });
execFileSync(npxCmd, ["vite", "build", "--base", "./", "--outDir", outDir, "--emptyOutDir"], {
  cwd: webDir,
  stdio: "inherit",
  shell,
});

console.log(`Built web client for Capacitor -> ${outDir}`);
