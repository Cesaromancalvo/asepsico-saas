import fs from 'node:fs';

const checks = [
  ['apps/api/src/dashboard/dashboard.module.ts', 'DashboardModule'],
  ['apps/api/src/dashboard/dashboard.controller.ts', "@Controller('dashboard')"],
  ['apps/api/src/dashboard/dashboard.service.ts', 'readByProfessionalAt: null'],
  ['apps/api/src/app.module.ts', 'DashboardModule'],
  ['apps/api/prisma/schema.prisma', 'onboardingCompletedAt'],
  ['apps/api/prisma/migrations/20260728010000_add_onboarding_progress/migration.sql', 'onboardingStep'],
  ['apps/web/app/page.tsx', "api<DashboardData>('/dashboard')"],
  ['apps/web/app/page.tsx', 'PRIMEROS PASOS'],
];
let failed = 0;
for (const [file, needle] of checks) {
  const ok = fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(needle);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${file} :: ${needle}`);
  if (!ok) failed++;
}
if (failed) process.exit(1);
console.log(`\n${checks.length} verificaciones superadas.`);
