-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "restrictedToRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
