-- AlterTable
ALTER TABLE "OidcAuthRequest" ADD COLUMN     "returnTarget" TEXT NOT NULL DEFAULT 'web';
