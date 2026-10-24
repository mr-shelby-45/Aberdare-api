-- CreateEnum
CREATE TYPE "sync_command_status" AS ENUM ('PROCESSING', 'ACCEPTED', 'FLAGGED', 'REJECTED');

-- CreateTable
CREATE TABLE "sync_command" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "command_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" "sync_command_status" NOT NULL,
    "result" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_command_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sync_command_business_id_command_id_key" ON "sync_command"("business_id", "command_id");

-- AddForeignKey
ALTER TABLE "sync_command" ADD CONSTRAINT "sync_command_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

