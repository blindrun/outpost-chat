// Builds the shared web client for Electron and copies the output into
// electron/web-dist/. A separate build from the one shipped in the Docker
// image: Electron loads index.html via file://, which needs relative asset
// paths (`./assets/x.js`), whereas the Docker image serves it from a real
// HTTP origin and needs absolute paths (`/assets/x.js`) — same source, two
// `vite build` invocations with different `--base`.
const { execSync } = require("node:child_process");
const { cpSync, rmSync, existsSync } = require("node:fs");
const path = require("node:path");

const webDir = path.join(__dirname, "..", "..", "web");
const outDir = path.join(__dirname, "..", "web-dist");

execSync("npx tsc -b && npx vite build --base ./ --outDir /tmp/harmony-electron-web-dist --emptyOutDir", {
  cwd: webDir,
  stdio: "inherit",
});

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
cpSync("/tmp/harmony-electron-web-dist", outDir, { recursive: true });
rmSync("/tmp/harmony-electron-web-dist", { recursive: true, force: true });

console.log(`Built web client for Electron -> ${outDir}`);
