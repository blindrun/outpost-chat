-- AlterTable
ALTER TABLE "InstanceSettings" ADD COLUMN     "enabledUploadCategories" TEXT[] DEFAULT ARRAY[]::TEXT[];
