-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "parentChannelId" TEXT,
ADD COLUMN     "parentMessageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Channel_parentMessageId_key" ON "Channel"("parentMessageId");

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_parentMessageId_fkey" FOREIGN KEY ("parentMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
