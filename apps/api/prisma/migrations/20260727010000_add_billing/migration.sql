CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT','ISSUED','PARTIALLY_PAID','PAID','VOID','OVERDUE');
CREATE TYPE "PaymentMethod" AS ENUM ('CASH','CARD','BANK_TRANSFER','BIZUM','DIRECT_DEBIT','OTHER');
CREATE TABLE "Invoice" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "patientId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL, "invoiceNumber" TEXT NOT NULL, "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
  "currency" TEXT NOT NULL DEFAULT 'EUR', "issueDate" TIMESTAMP(3), "dueDate" TIMESTAMP(3),
  "subtotalCents" INTEGER NOT NULL, "taxCents" INTEGER NOT NULL DEFAULT 0, "totalCents" INTEGER NOT NULL,
  "paidCents" INTEGER NOT NULL DEFAULT 0, "notes" TEXT, "voidReason" TEXT, "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "InvoiceLine" (
  "id" TEXT NOT NULL, "invoiceId" TEXT NOT NULL, "description" TEXT NOT NULL, "quantity" INTEGER NOT NULL DEFAULT 1,
  "unitPriceCents" INTEGER NOT NULL, "taxRateBps" INTEGER NOT NULL DEFAULT 0, "lineSubtotalCents" INTEGER NOT NULL,
  "lineTaxCents" INTEGER NOT NULL, "lineTotalCents" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Payment" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "patientId" TEXT NOT NULL, "invoiceId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL, "method" "PaymentMethod" NOT NULL, "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reference" TEXT, "idempotencyKey" TEXT, "notes" TEXT, "recordedById" TEXT NOT NULL,
  "reversedAt" TIMESTAMP(3), "reversalReason" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Invoice_workspaceId_sequence_key" ON "Invoice"("workspaceId","sequence");
CREATE UNIQUE INDEX "Invoice_workspaceId_invoiceNumber_key" ON "Invoice"("workspaceId","invoiceNumber");
CREATE INDEX "Invoice_workspaceId_status_dueDate_idx" ON "Invoice"("workspaceId","status","dueDate");
CREATE INDEX "Invoice_patientId_createdAt_idx" ON "Invoice"("patientId","createdAt");
CREATE INDEX "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");
CREATE UNIQUE INDEX "Payment_workspaceId_idempotencyKey_key" ON "Payment"("workspaceId","idempotencyKey");
CREATE INDEX "Payment_workspaceId_paidAt_idx" ON "Payment"("workspaceId","paidAt");
CREATE INDEX "Payment_invoiceId_paidAt_idx" ON "Payment"("invoiceId","paidAt");
CREATE INDEX "Payment_patientId_paidAt_idx" ON "Payment"("patientId","paidAt");
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
