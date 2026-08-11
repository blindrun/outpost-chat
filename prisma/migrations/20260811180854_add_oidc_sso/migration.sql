-- AlterTable
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "OidcIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OidcIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OidcAuthRequest" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "returnOrigin" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OidcAuthRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OidcExchangeCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mfaPending" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OidcExchangeCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OidcIdentity_userId_idx" ON "OidcIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OidcIdentity_issuer_subject_key" ON "OidcIdentity"("issuer", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "OidcAuthRequest_state_key" ON "OidcAuthRequest"("state");

-- CreateIndex
CREATE INDEX "OidcAuthRequest_expiresAt_idx" ON "OidcAuthRequest"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "OidcExchangeCode_codeHash_key" ON "OidcExchangeCode"("codeHash");

-- CreateIndex
CREATE INDEX "OidcExchangeCode_expiresAt_idx" ON "OidcExchangeCode"("expiresAt");

-- AddForeignKey
ALTER TABLE "OidcIdentity" ADD CONSTRAINT "OidcIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
