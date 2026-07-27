-- DropIndex
DROP INDEX "Server_inviteCode_key";

-- AlterTable
ALTER TABLE "Server" DROP COLUMN "inviteCode";

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "maxUses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invite_code_key" ON "Invite"("code");

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
