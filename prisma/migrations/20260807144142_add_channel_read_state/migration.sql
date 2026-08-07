-- CreateTable
CREATE TABLE "ChannelReadState" (
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelReadState_pkey" PRIMARY KEY ("userId","channelId")
);
