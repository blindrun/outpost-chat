-- CreateTable
CREATE TABLE "ClaimCode" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimCode_pkey" PRIMARY KEY ("id")
);
