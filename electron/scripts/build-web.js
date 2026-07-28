// Builds the shared web client for Electron and writes it straight into
// electron/web-dist/. A separate build from the one shipped in the Docker
// image: Electron loads index.html via file://, which needs relative asset
// paths (`./assets/x.js`), whereas the Docker image serves it from a real
// HTTP origin and needs absolute paths (`/assets/x.js`) — same source, two
// `vite build` invocations with different `--base`.
const { execFileSync } = require("node:child_process");
const { rmSync } = require("node:fs");
const path = require("node:path");

const webDir = path.join(__dirname, "..", "..", "web");
const outDir = path.join(__dirname, "..", "web-dist");

rmSync(outDir, { recursive: true, force: true });

const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
execFileSync(npxCmd, ["tsc", "-b"], { cwd: webDir, stdio: "inherit" });
execFileSync(npxCmd, ["vite", "build", "--base", "./", "--outDir", outDir, "--emptyOutDir"], {
  cwd: webDir,
  stdio: "inherit",
});

console.log(`Built web client for Electron -> ${outDir}`);
