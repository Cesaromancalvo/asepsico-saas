-- Último paso TOTP aceptado por usuario, para rechazar la reutilización de un mismo
-- código dentro de su ventana de validez (RFC 6238 §5.2). Nullable: NULL = ningún código
-- TOTP usado todavía (o MFA recién configurado/desactivado).
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "totpLastUsedStep" INTEGER;
