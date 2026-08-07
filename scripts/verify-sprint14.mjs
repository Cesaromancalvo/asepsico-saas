import fs from 'node:fs';
const root = new URL('../', import.meta.url);
const checks = [
  'apps/api/src/exports/exports.module.ts',
  'apps/api/src/exports/exports.controller.ts',
  'apps/api/src/exports/exports.service.ts',
  'apps/web/app/settings/data/page.tsx',
  'scripts/backup-postgres.sh',
  'scripts/restore-check.sh',
  'ops/PILOT_RUNBOOK.md',
  'SPRINT_14_EXPORTACIONES_BACKUPS_PILOTO.md',
];
let failed = false;
for (const path of checks) {
  const ok = fs.existsSync(new URL(path, root));
  console.log(`${ok ? 'PASS' : 'FAIL'} ${path}`);
  failed ||= !ok;
}
const app = fs.readFileSync(new URL('apps/api/src/app.module.ts', root), 'utf8');
const service = fs.readFileSync(new URL('apps/api/src/exports/exports.service.ts', root), 'utf8');
for (const [label, ok] of [
  ['ExportsModule registered', app.includes('ExportsModule')],
  ['workspace scoping', service.includes('workspaceId: user.workspaceId')],
  ['therapist patient restriction', service.includes("user.role === 'THERAPIST'")],
  ['export audit', service.includes('PATIENT_DATA_EXPORTED') && service.includes('WORKSPACE_DATA_EXPORTED')],
]) { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); failed ||= !ok; }
if (failed) process.exit(1);
