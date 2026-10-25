-- CreateEnum
CREATE TYPE "business_type" AS ENUM ('RETAIL', 'WHOLESALE', 'WAREHOUSE');

-- CreateEnum
CREATE TYPE "otp_channel" AS ENUM ('SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "otp_purpose" AS ENUM ('SIGNUP', 'STAFF_ACTIVATE', 'PASSWORD_RESET');

-- AlterTable
ALTER TABLE "business" ADD COLUMN     "type" "business_type" NOT NULL;

-- CreateTable
CREATE TABLE "otp_challenge" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "channel" "otp_channel" NOT NULL,
    "target" TEXT NOT NULL,
    "purpose" "otp_purpose" NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "verified_at" TIMESTAMPTZ(6),
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "otp_challenge_target_purpose_created_at_idx" ON "otp_challenge"("target", "purpose", "created_at");

