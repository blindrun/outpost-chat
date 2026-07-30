-- DropIndex
DROP INDEX "ReactionRole_emoji_key";

-- AlterTable
ALTER TABLE "BotSettings" DROP COLUMN "reactionRoleChannelId",
DROP COLUMN "reactionRoleMessageId";

-- AlterTable
ALTER TABLE "ReactionRole" ADD COLUMN     "channelId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "ReactionRoleMenu" (
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,

    CONSTRAINT "ReactionRoleMenu_pkey" PRIMARY KEY ("channelId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReactionRole_channelId_emoji_key" ON "ReactionRole"("channelId", "emoji");

-- AddForeignKey
ALTER TABLE "ReactionRole" ADD CONSTRAINT "ReactionRole_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReactionRoleMenu" ADD CONSTRAINT "ReactionRoleMenu_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
