-- CreateTable
CREATE TABLE "location" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pack_type" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "units_per_pack" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pack_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "pack_type_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "pack_type_id" UUID NOT NULL,
    "quantity_change" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_conversion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "out_movement_id" UUID NOT NULL,
    "in_movement_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_conversion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "location_business_id_id_key" ON "location"("business_id", "id");

-- CreateIndex
CREATE INDEX "pack_type_business_id_product_id_idx" ON "pack_type"("business_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "pack_type_business_id_id_key" ON "pack_type"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balance_business_id_location_id_pack_type_id_key" ON "stock_balance"("business_id", "location_id", "pack_type_id");

-- CreateIndex
CREATE INDEX "stock_movement_business_id_location_id_pack_type_id_idx" ON "stock_movement"("business_id", "location_id", "pack_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movement_business_id_id_key" ON "stock_movement"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_conversion_business_id_out_movement_id_key" ON "stock_conversion"("business_id", "out_movement_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_conversion_business_id_in_movement_id_key" ON "stock_conversion"("business_id", "in_movement_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_business_id_id_key" ON "product"("business_id", "id");

-- AddForeignKey
ALTER TABLE "location" ADD CONSTRAINT "location_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pack_type" ADD CONSTRAINT "pack_type_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pack_type" ADD CONSTRAINT "pack_type_business_id_product_id_fkey" FOREIGN KEY ("business_id", "product_id") REFERENCES "product"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_business_id_location_id_fkey" FOREIGN KEY ("business_id", "location_id") REFERENCES "location"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_business_id_pack_type_id_fkey" FOREIGN KEY ("business_id", "pack_type_id") REFERENCES "pack_type"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_business_id_location_id_fkey" FOREIGN KEY ("business_id", "location_id") REFERENCES "location"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_business_id_pack_type_id_fkey" FOREIGN KEY ("business_id", "pack_type_id") REFERENCES "pack_type"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_conversion" ADD CONSTRAINT "stock_conversion_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_conversion" ADD CONSTRAINT "stock_conversion_business_id_out_movement_id_fkey" FOREIGN KEY ("business_id", "out_movement_id") REFERENCES "stock_movement"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_conversion" ADD CONSTRAINT "stock_conversion_business_id_in_movement_id_fkey" FOREIGN KEY ("business_id", "in_movement_id") REFERENCES "stock_movement"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

