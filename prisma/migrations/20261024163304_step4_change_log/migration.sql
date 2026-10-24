-- CreateTable
CREATE TABLE "change_log" (
    "id" BIGSERIAL NOT NULL,
    "business_id" UUID NOT NULL,
    "table_name" TEXT NOT NULL,
    "row_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "change_log_business_id_id_idx" ON "change_log"("business_id", "id");

-- AddForeignKey
ALTER TABLE "change_log" ADD CONSTRAINT "change_log_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

