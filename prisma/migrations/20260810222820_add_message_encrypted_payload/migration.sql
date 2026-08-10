-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "encryptedPayload" TEXT,
ADD COLUMN     "encryptionVersion" INTEGER;
