import { Client } from "minio";

export const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT ?? "localhost",
  port: Number(process.env.MINIO_PORT ?? 9000),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY ?? "",
  secretKey: process.env.MINIO_SECRET_KEY ?? "",
});

export const BUCKET = process.env.MINIO_BUCKET ?? "outpost-uploads";
// Routes through the app's own port by default now, not MinIO's (9000)
// directly — see routes/fileServing.ts. The bucket is private; nothing can
// fetch from MinIO's own port without valid MinIO credentials anymore.
export const PUBLIC_URL = process.env.MINIO_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8080}/${BUCKET}`;

// Private bucket (MinIO's default — no explicit policy needed, but ensured
// idempotently in case a pre-existing bucket from before this change still
// has the old public-read policy attached). Uploaded files are served
// through the app's own authenticated proxy route instead (see
// routes/fileServing.ts) — a leaked or guessed object key alone no longer
// works, unlike the previous public-read setup.
export async function ensureBucket() {
  const exists = await minioClient.bucketExists(BUCKET).catch(() => false);
  if (!exists) {
    await minioClient.makeBucket(BUCKET);
  }
  await minioClient.setBucketPolicy(BUCKET, "").catch(() => {});
}

// `url.startsWith(PUBLIC_URL)` was the old check, and prefix matching is the
// wrong primitive for deciding whether a URL is ours. It only held here by
// accident: PUBLIC_URL happens to carry a path (the bucket), so a string
// starting with it stays same-origin. Point MINIO_PUBLIC_URL at a bare origin
// -- which a self-hoster reasonably might, e.g. a CDN hostname -- and
// `https://cdn.example.com.attacker.test/x` passes, because that really does
// start with `https://cdn.example.com`.
//
// That matters because these URLs are later handed to the client, which
// appends the viewer's session token as a query parameter to fetch them. A
// URL that is ours by prefix but not by origin exfiltrates the token.
//
// So: parse both sides and require the origin to match exactly, then require
// the path to be inside the bucket, on a path-segment boundary so
// `/bucket-evil/...` cannot pass as `/bucket/...`.
export function isOwnUploadUrl(candidate: string): boolean {
  let url: URL;
  let base: URL;
  try {
    url = new URL(candidate);
    base = new URL(PUBLIC_URL);
  } catch {
    return false;
  }
  if (url.origin !== base.origin) return false;

  const basePath = base.pathname.replace(/\/+$/, "");
  if (!basePath) return true;
  return url.pathname === basePath || url.pathname.startsWith(basePath + "/");
}
