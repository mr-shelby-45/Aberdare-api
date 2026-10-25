-- CreateEnum
CREATE TYPE "role_preset" AS ENUM ('OWNER', 'MANAGER', 'ATTENDANT');

-- CreateEnum
CREATE TYPE "membership_status" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED');

-- CreateEnum
CREATE TYPE "device_status" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateTable
CREATE TABLE "person" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "phone" TEXT NOT NULL,
    "phone_verified_at" TIMESTAMPTZ(6),
    "email" TEXT,
    "email_verified_at" TIMESTAMPTZ(6),
    "password_hash" TEXT,
    "password_changed_at" TIMESTAMPTZ(6),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "login_locked_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "role_preset" "role_preset" NOT NULL,
    "extra_permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "membership_status" NOT NULL,
    "pin_hash" TEXT,
    "pin_set_at" TIMESTAMPTZ(6),
    "pin_failed_count" INTEGER NOT NULL DEFAULT 0,
    "pin_locked_until" TIMESTAMPTZ(6),
    "temp_pin_hash" TEXT,
    "temp_pin_expires_at" TIMESTAMPTZ(6),
    "temp_pin_failed_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_membership_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "is_shared" BOOLEAN NOT NULL DEFAULT false,
    "status" "device_status" NOT NULL,
    "registered_by_membership_id" UUID NOT NULL,
    "push_token" TEXT,
    "last_seen_at" TIMESTAMPTZ(6),
    "last_sync_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_membership" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "person_phone_key" ON "person"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "person_email_key" ON "person"("email");

-- CreateIndex
CREATE INDEX "membership_person_id_idx" ON "membership"("person_id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_business_id_id_key" ON "membership"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_business_id_person_id_key" ON "membership"("business_id", "person_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_business_id_id_key" ON "device"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "device_membership_business_id_device_id_membership_id_key" ON "device_membership"("business_id", "device_id", "membership_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_token_business_id_family_id_idx" ON "refresh_token"("business_id", "family_id");

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_business_id_created_by_membership_id_fkey" FOREIGN KEY ("business_id", "created_by_membership_id") REFERENCES "membership"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device" ADD CONSTRAINT "device_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device" ADD CONSTRAINT "device_business_id_registered_by_membership_id_fkey" FOREIGN KEY ("business_id", "registered_by_membership_id") REFERENCES "membership"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_membership" ADD CONSTRAINT "device_membership_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_membership" ADD CONSTRAINT "device_membership_business_id_device_id_fkey" FOREIGN KEY ("business_id", "device_id") REFERENCES "device"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_membership" ADD CONSTRAINT "device_membership_business_id_membership_id_fkey" FOREIGN KEY ("business_id", "membership_id") REFERENCES "membership"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_business_id_membership_id_fkey" FOREIGN KEY ("business_id", "membership_id") REFERENCES "membership"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_business_id_device_id_fkey" FOREIGN KEY ("business_id", "device_id") REFERENCES "device"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

