// Who is allowed to receive a session token.
//
// Both checks fixed here decide whether a URL is "ours". Getting that wrong
// does not fail loudly: the URL loads, the image renders, and the viewer's
// session token has gone somewhere else. The negative cases below are the
// whole point of this file.
//
//   node --experimental-strip-types tests/security/upload-url-scope.mjs

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { console.log(`PASS  ${name}`); pass++; }
  else { console.log(`FAIL  ${name}  (got ${got}, wanted ${want})`); fail++; }
}

// Set before importing: PUBLIC_URL is read at module load.
process.env.MINIO_PUBLIC_URL = "https://outpost.example.com/outpost-uploads";
const { isOwnUploadUrl } = await import("../../src/plugins/storage.ts");

console.log("isOwnUploadUrl, PUBLIC_URL = https://outpost.example.com/outpost-uploads");
check("the bucket root itself", isOwnUploadUrl("https://outpost.example.com/outpost-uploads"), true);
check("an object inside the bucket", isOwnUploadUrl("https://outpost.example.com/outpost-uploads/u/1.png"), true);

// The reason prefix matching is wrong. Each of these passes `startsWith`.
check("sibling bucket that shares the prefix",
  isOwnUploadUrl("https://outpost.example.com/outpost-uploads-evil/x.png"), false);
check("path that only looks like the bucket",
  isOwnUploadUrl("https://outpost.example.com/outpost-uploadsX/x.png"), false);
check("different origin entirely",
  isOwnUploadUrl("https://attacker.test/outpost-uploads/x.png"), false);
check("credentials trick pointing at another host",
  isOwnUploadUrl("https://outpost.example.com@attacker.test/outpost-uploads/x.png"), false);
check("protocol-relative garbage", isOwnUploadUrl("//attacker.test/outpost-uploads/x"), false);
check("not a URL at all", isOwnUploadUrl("outpost-uploads/x.png"), false);
check("empty", isOwnUploadUrl(""), false);

// The bare-origin deployment, which is what makes prefix matching dangerous
// rather than merely sloppy. A self-hoster pointing this at a CDN hostname
// gets no path component to save them.
console.log("\nsame check where PUBLIC_URL is a bare origin");
process.env.MINIO_PUBLIC_URL = "https://cdn.example.com";
const { isOwnUploadUrl: isOwnBare } = await import("../../src/plugins/storage.ts?v=2");
check("lookalike subdomain suffix is rejected",
  isOwnBare("https://cdn.example.com.attacker.test/x.png"), false);
check("the real origin is still accepted",
  isOwnBare("https://cdn.example.com/x.png"), true);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
