import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const workflowPath = '.github/workflows/ci.yml';
const workflow = readFileSync(workflowPath, 'utf8');
const checks = [
  ['job postgres-integration', /postgres-integration:/],
  ['service postgres', /services:\s*\n\s+postgres:/],
  ['PostgreSQL 16', /image:\s*postgres:16-alpine/],
  ['healthcheck pg_isready', /pg_isready -U asepsico -d asepsico/],
  ['db:generate', /npm run db:generate/],
  ['db:migrate:ci', /npm run db:migrate:ci/],
  ['seed', /npm run db:seed/],
  ['API start', /npm --workspace @asepsico\/api run start/],
  ['real health endpoint', /127\.0\.0\.1:4000\/api\/v1\/health/],
  ['real HTTP smoke test', /npm run test:smoke/],
  ['failure log artifact', /actions\/upload-artifact@v4/],
];

const failures = checks.filter(([, pattern]) => !pattern.test(workflow));
if (failures.length) {
  for (const [name] of failures) console.error(`FAIL: ${name}`);
  process.exit(1);
}

const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
const apiPackage = JSON.parse(readFileSync('apps/api/package.json', 'utf8'));
if (rootPackage.scripts?.['db:migrate:ci'] !== 'npm --workspace @asepsico/api run prisma:migrate:deploy') {
  throw new Error('El script raíz db:migrate:ci no está configurado correctamente');
}
if (apiPackage.scripts?.['prisma:migrate:deploy'] !== 'prisma migrate deploy') {
  throw new Error('El script prisma:migrate:deploy no está configurado correctamente');
}

// Comprobación FUNCIONAL, no solo textual: que el comando que la CI realmente ejecuta para
// pruebas encuentre al menos un test. Revisar solo el texto del workflow no habría pillado
// nunca el caso real en el que "npm run test" apuntaba a un jest sin configuración y
// silenciosamente no encontraba ningún archivo — el job de CI habría fallado en el primer
// push real pese a que este script decía "todo correcto".
let listedTests;
try {
  listedTests = execFileSync(
    'npm',
    ['--workspace', '@asepsico/api', 'run', 'test', '--', '--listTests'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
} catch (error) {
  throw new Error(
    `El script "test" de apps/api no se pudo ejecutar (¿jest mal configurado?): ${error.stderr || error.message}`,
  );
}
const testFiles = listedTests.split('\n').filter((line) => line.trim().endsWith('.ts'));
if (testFiles.length === 0) {
  throw new Error(
    'El script "test" de apps/api no encontró ningún archivo de test. La CI pasaría en falso ' +
      '(o fallaría en el primer push real) sin que este script lo detectara si no se ejecutara de verdad.',
  );
}

const smoke = readFileSync('scripts/smoke-live.mjs', 'utf8');
if (/priority:\s*['"](?:LOW|MEDIUM|HIGH)['"]/.test(smoke)) {
  throw new Error('El smoke test usa una prioridad textual incompatible con CreateTherapyGoalDto; debe usar 1, 2 o 3');
}
if (!/priority:\s*2/.test(smoke)) {
  throw new Error('El smoke test no contiene una prioridad numérica válida para el objetivo terapéutico');
}

console.log(`OK: ${checks.length} comprobaciones textuales + ${testFiles.length} archivos de test detectados de verdad.`);
