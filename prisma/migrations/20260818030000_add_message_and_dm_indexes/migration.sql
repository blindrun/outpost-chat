-- CreateIndex
CREATE INDEX "DMParticipant_userId_idx" ON "DMParticipant"("userId");

-- CreateIndex
CREATE INDEX "Message_channelId_createdAt_idx" ON "Message"("channelId", "createdAt");

