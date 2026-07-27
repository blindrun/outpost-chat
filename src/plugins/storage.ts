import { Client } from "minio";

export const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT ?? "localhost",
  port: Number(process.env.MINIO_PORT ?? 9000),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY ?? "",
  secretKey: process.env.MINIO_SECRET_KEY ?? "",
});

export const BUCKET = process.env.MINIO_BUCKET ?? "discord-clone-uploads";
export const PUBLIC_URL = process.env.MINIO_PUBLIC_URL ?? `http://localhost:9000/${BUCKET}`;

const publicReadPolicy = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { AWS: ["*"] },
      Action: ["s3:GetObject"],
      Resource: [`arn:aws:s3:::${BUCKET}/*`],
    },
  ],
});

// Dev-only convenience: uploaded files are served back at a stable, directly
// fetchable public URL rather than minting presigned GETs per request — this
// bucket has no sensitive content (avatars/attachments only), so public-read
// is an acceptable tradeoff here, not something to carry into a real deploy.
export async function ensureBucket() {
  const exists = await minioClient.bucketExists(BUCKET).catch(() => false);
  if (!exists) {
    await minioClient.makeBucket(BUCKET);
  }
  await minioClient.setBucketPolicy(BUCKET, publicReadPolicy);
}
