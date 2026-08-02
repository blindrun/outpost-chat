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
