import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Express } from "express";
import { randomUUID } from "node:crypto";

const maxPdfSizeBytes = 10 * 1024 * 1024;
const maxImageSizeBytes = 5 * 1024 * 1024;
const r2Endpoint =
  process.env.R2_ENDPOINT ||
  (process.env.R2_ACCOUNT_ID
    ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
    : undefined);

const r2Client = new S3Client({
  region: "auto",
  endpoint: r2Endpoint,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  },
});

export function getMaxPdfSizeBytes() {
  return maxPdfSizeBytes;
}

export function getMaxImageSizeBytes() {
  return maxImageSizeBytes;
}

export async function uploadPdfToR2(
  file: Express.Multer.File,
  userId: string,
  assignmentId: string,
) {
  const bucket = process.env.R2_BUCKET_NAME;
  const publicUrl = process.env.R2_PUBLIC_URL?.replace(/\/$/, "");

  if (
    !bucket ||
    !publicUrl ||
    !r2Endpoint ||
    !process.env.R2_ACCESS_KEY_ID ||
    !process.env.R2_SECRET_ACCESS_KEY
  ) {
    throw new Error(
      "Cloudflare R2 is not configured. Set R2_BUCKET_NAME, R2_PUBLIC_URL, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.",
    );
  }

  const key = `submissions/${userId}/${assignmentId}/${randomUUID()}.pdf`;

  await r2Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: file.buffer,
      ContentType: "application/pdf",
      ContentLength: file.size,
      ContentDisposition: "inline",
    }),
  );

  return `${publicUrl}/${key}`;
}

export async function uploadImageToR2(
  file: Express.Multer.File,
  userId: string,
) {
  const bucket = process.env.R2_BUCKET_NAME;
  const publicUrl = process.env.R2_PUBLIC_URL?.replace(/\/$/, "");

  if (
    !bucket ||
    !publicUrl ||
    !r2Endpoint ||
    !process.env.R2_ACCESS_KEY_ID ||
    !process.env.R2_SECRET_ACCESS_KEY
  ) {
    throw new Error(
      "Cloudflare R2 is not configured. Set R2_BUCKET_NAME, R2_PUBLIC_URL, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.",
    );
  }

  const extension =
    file.mimetype.split("/")[1] === "jpeg"
      ? "jpg"
      : file.mimetype.split("/")[1];
  const key = `profile-images/${userId}/${randomUUID()}.${extension}`;

  await r2Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      ContentLength: file.size,
      ContentDisposition: "inline",
    }),
  );

  return `${publicUrl}/${key}`;
}
