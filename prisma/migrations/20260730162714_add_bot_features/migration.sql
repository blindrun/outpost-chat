-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "isSystemBot" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "BotSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "name" TEXT NOT NULL DEFAULT 'Outpost Bot',
    "avatarUrl" TEXT,
    "welcomeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "welcomeChannelId" TEXT,
    "welcomeMessage" TEXT NOT NULL DEFAULT 'Welcome to the server, {user}! 👋',
    "autoRoleEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoRoleId" TEXT,
    "customCommandsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "reactionRolesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "reactionRoleChannelId" TEXT,
    "reactionRoleMessageId" TEXT,
    "levelingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "levelUpAnnounce" BOOLEAN NOT NULL DEFAULT true,
    "levelUpMessage" TEXT NOT NULL DEFAULT '🎉 {user} just reached level {level}!',
    "automodEnabled" BOOLEAN NOT NULL DEFAULT false,
    "automodBannedWords" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "BotSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomCommand" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReactionRole" (
    "id" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReactionRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserLevel" (
    "userId" TEXT NOT NULL,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 0,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "lastXpAt" TIMESTAMP(3),

    CONSTRAINT "UserLevel_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomCommand_trigger_key" ON "CustomCommand"("trigger");

-- CreateIndex
CREATE UNIQUE INDEX "ReactionRole_emoji_key" ON "ReactionRole"("emoji");

-- AddForeignKey
ALTER TABLE "ReactionRole" ADD CONSTRAINT "ReactionRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
