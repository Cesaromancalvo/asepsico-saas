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
  [
    'drift check migraciones vs schema.prisma',
    /npx prisma migrate diff\s*\\?\s*\n?\s*--from-url "\$DATABASE_URL"\s*\\?\s*\n?\s*--to-schema-datamodel prisma\/schema\.prisma\s*\\?\s*\n?\s*--exit-code/,
  ],
  ['seed', /npm run db:seed/],
  ['API start', /npm --workspace @asepsico\/api run start/],
  ['real health endpoint', /127\.0\.0\.1:4000\/api\/v1\/health/],
  ['real HTTP smoke test', /npm run test:smoke/],
  // Cuenta existente con condiciones nuevas: 428 → acepta → sin 428 (condición de Argos), con la API
  // reiniciada con datos del titular FICTICIOS (12345678Z) tras sembrar sin ellos.
  ['smoke del 428 de condiciones nuevas', /ASEPSICO_SMOKE_EXPECT_TERMS_428:\s*'1'/],
  ['API reiniciada con NIF ficticio para el 428', /LEGAL_TITULAR_NIF:\s*12345678Z/],
  ['smoke con MFA temporal (BD desechable)', /ASEPSICO_SMOKE_ENROLL_MFA:\s*'1'/],
  ['failure log artifact', /actions\/upload-artifact@v4/],
  // La API de CI solo confía en loopback; nunca "true" (permitiría falsear la IP del throttle).
  ['TRUST_PROXY de CI acotado a loopback', /TRUST_PROXY:\s*loopback/],
  ['verificación de concurrencia MFA (condicionada a que exista el script)', /node scripts\/verify-mfa-concurrency\.mjs/],
  ['test de carrera session-close-race en postgres-integration', /--testPathPattern session-close-race/],
  ['RACE_DATABASE_URL hacia el Postgres del servicio', /RACE_DATABASE_URL:\s*postgresql:\/\/asepsico:asepsico@localhost:5432\/asepsico/],
  ['RACE_DATABASE_REQUIRED=1 (falla en vez de omitirse)', /RACE_DATABASE_REQUIRED:\s*'1'/],
];

// Hallazgo de Argos: la contraseña de la cuenta demo no puede ser un literal en el workflow;
// se genera por ejecución y llega al seed y a los scripts por GITHUB_ENV.
checks.push(
  ['contraseña del seed generada por ejecución', /echo "SEED_DEMO_PASSWORD=\$pass" >> "\$GITHUB_ENV"/],
  ['contraseña del smoke = la del seed', /echo "ASEPSICO_SMOKE_PASSWORD=\$pass" >> "\$GITHUB_ENV"/],
);
// Condición de Argos: la contraseña generada tiene al menos 24 caracteres o el paso falla, y la
// comprobación va entre la generación y la escritura en GITHUB_ENV.
{
  const genIndex = workflow.indexOf('pass="$(openssl rand');
  const lengthIndex = workflow.search(/^\s*\[ \$\{#pass\} -ge 24 \] \|\| exit 1\s*$/m);
  const exportIndex = workflow.indexOf('echo "SEED_DEMO_PASSWORD=$pass"');
  if (genIndex < 0 || lengthIndex < genIndex || lengthIndex > exportIndex) {
    console.error('FAIL: tras generar la contraseña del seed, el workflow debe exigir [ ${#pass} -ge 24 ] || exit 1 antes de exportarla');
    process.exit(1);
  }
}
if (/AsePsico2026!/.test(workflow) || /ASEPSICO_SMOKE_PASSWORD:\s*\S/.test(workflow) || /SEED_DEMO_PASSWORD:\s*\S/.test(workflow)) {
  console.error('FAIL: el workflow no debe fijar la contraseña de la cuenta demo');
  process.exit(1);
}
if (workflow.indexOf('Generate disposable seed password') > workflow.indexOf('npm run db:seed')) {
  console.error('FAIL: la contraseña del seed debe generarse antes de npm run db:seed');
  process.exit(1);
}

const failures = checks.filter(([, pattern]) => !pattern.test(workflow));
if (failures.length) {
  for (const [name] of failures) console.error(`FAIL: ${name}`);
  process.exit(1);
}

// El drift check solo tiene sentido sobre la BD ya migrada: debe ir después de db:migrate:ci
// y fallar el job si `migrate diff` devuelve 2 (hay diferencias).
const migrateIndex = workflow.indexOf('npm run db:migrate:ci');
const driftIndex = workflow.indexOf('npx prisma migrate diff');
if (driftIndex < migrateIndex) {
  throw new Error('El paso de drift (prisma migrate diff) debe ir después de "npm run db:migrate:ci"');
}
if (!/"\$status" -eq 2 \][\s\S]*?exit 1/.test(workflow)) {
  throw new Error('El paso de drift debe hacer fallar el job cuando prisma migrate diff devuelve 2');
}

// La ráfaga MFA necesita la API levantada y deja la cuenta en espera: después del smoke.
const smokeIndex = workflow.indexOf('npm run test:smoke');
const mfaIndex = workflow.indexOf('node scripts/verify-mfa-concurrency.mjs');
if (mfaIndex < smokeIndex) {
  throw new Error('verify-mfa-concurrency debe ejecutarse después del smoke HTTP real');
}
// Registro por invitación: la ráfaga concurrente contra PostgreSQL real debe ejecutarse siempre.
const inviteIndex = workflow.indexOf('node scripts/verify-registration-invite-live.mjs');
if (inviteIndex < 0 || inviteIndex < smokeIndex) {
  throw new Error('verify-registration-invite-live debe ejecutarse en CI después del smoke HTTP real');
}
// El test de carrera necesita la BD migrada y debe vivir en postgres-integration (no en quality).
const postgresJobIndex = workflow.indexOf('postgres-integration:');
const raceIndex = workflow.indexOf('--testPathPattern session-close-race');
if (raceIndex < postgresJobIndex || raceIndex < migrateIndex) {
  throw new Error('session-close-race debe ejecutarse en el job postgres-integration, después de db:migrate:ci');
}
const raceSpec = readFileSync('apps/api/test/session-close-race.security-spec.ts', 'utf8');
if (!/RACE_DATABASE_REQUIRED === '1' && !url\) \{\s*\n\s*throw/.test(raceSpec)) {
  throw new Error('session-close-race debe fallar (no omitirse) cuando RACE_DATABASE_REQUIRED=1 y falta RACE_DATABASE_URL');
}
// Reinicio de la API para el 428 (PR #20): `npm run start` deja colgando sh → nest → node dist/main
// y en Ubuntu dash no reenvía SIGTERM. Matar solo el PID de npm dejaba viva la API vieja en :4000 y
// el smoke del 428 recibía 200. Cada arranque va en su propio grupo (setsid), cada parada mata el
// grupo entero (kill -- -PGID) y el reinicio falla si la API anterior sigue respondiendo.
{
  const starts = workflow.match(/^\s*(setsid )?npm --workspace @asepsico\/api run start\b/gm) ?? [];
  if (starts.length === 0 || starts.some((line) => !line.includes('setsid '))) {
    throw new Error('Cada arranque de la API en CI debe ir con setsid (grupo de procesos propio)');
  }
  if (/kill "\$\(cat "\$RUNNER_TEMP\/asepsico-api\.pid"\)"/.test(workflow)) {
    throw new Error('Parar la API matando solo el PID de npm deja viva la API: usa kill -- "-$(cat ...pid)"');
  }
  if (!/La API anterior sigue respondiendo en :4000/.test(workflow)) {
    throw new Error('El reinicio de la API debe fallar si la API anterior sigue respondiendo en :4000');
  }
}
if (/TRUST_PROXY:\s*['"]?true/i.test(workflow)) {
  throw new Error('La CI no debe usar TRUST_PROXY=true');
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

// El smoke real es el único test que ejecuta las migraciones contra Postgres y la API de verdad:
// debe seguir cubriendo que un paciente admite dos cuentas de portal (paciente + tutor).
if (!/accessorType:\s*'PATIENT'/.test(smoke) || !/accessorType:\s*'GUARDIAN'/.test(smoke)) {
  throw new Error('El smoke test debe habilitar dos cuentas de portal (PATIENT y GUARDIAN) para el mismo paciente');
}

// Repo público: la contraseña de las cuentas de portal del smoke no puede ser un literal fijo,
// y el smoke no puede dejar accesos vivos (revoca en un finally antes de archivar).
if (!/randomBytes\(/.test(smoke) || /temporaryPassword:\s*'[^']+'/.test(smoke)) {
  throw new Error('El smoke debe generar la contraseña de portal con crypto.randomBytes, no un literal');
}
if (!/finally\s*\{[\s\S]*?\/portal-account`,\s*\{\s*method:\s*'DELETE'/.test(smoke)) {
  throw new Error('El smoke debe desactivar las cuentas de portal (DELETE portal-account) en un finally');
}

// La API exige MFA a OWNER/ADMIN/THERAPIST: sin este flujo el smoke muere con 403 en el paso 2.
if (!/\/auth\/mfa\/setup/.test(smoke) || !/\/auth\/mfa\/confirm/.test(smoke) || !/\/auth\/refresh/.test(smoke)) {
  throw new Error('El smoke test no contempla el MFA obligatorio (mfa/setup + mfa/confirm + refresh)');
}

// ENROLL_MFA modifica la cuenta: solo contra hosts locales, salvo válvula explícita que la CI no usa.
if (!/assertEnrollmentTargetAllowed\(\);\s*\n\s*const setup = await req\('\/auth\/mfa\/setup'/.test(smoke) ||
    !/'localhost',\s*'127\.0\.0\.1',\s*'::1'/.test(smoke)) {
  throw new Error('El smoke debe bloquear ASEPSICO_SMOKE_ENROLL_MFA contra hosts no locales antes de mfa/setup');
}
if (/ASEPSICO_SMOKE_ALLOW_REMOTE_ENROLL/.test(workflow)) {
  throw new Error('La CI no debe definir ASEPSICO_SMOKE_ALLOW_REMOTE_ENROLL');
}
if (!/recoveryCodes/.test(smoke)) {
  throw new Error('El smoke debe desactivar el MFA temporal con un código de recuperación, no reutilizando el TOTP');
}

// Web: las pruebas unitarias de apps/web y el build cerrado de la landing (condición de Argos)
// deben ejecutarse en el job quality.
const qualityIndex = workflow.indexOf('quality:');
const postgresIntegrationIndex = workflow.indexOf('postgres-integration:');
const webTestIndex = workflow.indexOf('npm --workspace @asepsico/web run test');
if (webTestIndex < qualityIndex || webTestIndex > postgresIntegrationIndex) {
  throw new Error('Las pruebas de la web (npm --workspace @asepsico/web run test) deben ejecutarse en el job quality');
}
const landingBuildIndex = workflow.indexOf('env -u LEGAL_TITULAR_NIF -u LEGAL_TITULAR_DOMICILIO node apps/landing/build.mjs');
if (landingBuildIndex < qualityIndex || landingBuildIndex > postgresIntegrationIndex ||
    !/if \[ "\$status" -eq 0 \]; then[\s\S]*?exit 1/.test(workflow.slice(landingBuildIndex))) {
  throw new Error('El job quality debe comprobar que apps/landing/build.mjs falla sin LEGAL_TITULAR_NIF ni LEGAL_TITULAR_DOMICILIO');
}

// Pasos que deben poder romper el job (QA, revisión del CI de la S3): se localiza cada paso por su
// nombre y se comprueba su bloque, no el texto suelto del workflow (un comando comentado, un
// `if: false` o un `continue-on-error` dejarían el paso en verde sin ejecutar nada).
if (/^\s*continue-on-error:/m.test(workflow)) {
  throw new Error('El workflow no debe usar continue-on-error: un paso que falla tiene que romper el job');
}
function stepsOf(job) {
  const start = workflow.search(new RegExp(`^  ${job}:\\s*$`, 'm'));
  if (start < 0) throw new Error(`No existe el job ${job}`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/^  [\w-]+:\s*$/m);
  const body = next < 0 ? rest : rest.slice(0, next);
  return body.split(/^(?=      - name: )/m).slice(1).map((block) => ({
    name: block.match(/^      - name: (.+)$/m)[1].trim(),
    block,
    // Sin comentarios YAML de línea completa (los que empiezan por # tras la sangría).
    code: block.replace(/^\s*#.*$/gm, ''),
  }));
}
function requiredStep(job, name, command) {
  const step = stepsOf(job).find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Falta el paso "${name}" en el job ${job}`);
  if (/^\s{8}if:/m.test(step.block)) throw new Error(`El paso "${name}" no puede llevar if: (se omitiría en silencio)`);
  const lines = step.code.split('\n').map((line) => line.trim());
  if (!lines.some((line) => line === command || line === `run: ${command}`)) {
    throw new Error(`El paso "${name}" debe ejecutar exactamente: ${command}`);
  }
  return step;
}
requiredStep('quality', 'Web unit tests', 'npm --workspace @asepsico/web run test -- --ci');
requiredStep('postgres-integration', 'Session close race test (real PostgreSQL)',
  'npm --workspace @asepsico/api run test:security -- --ci --testPathPattern session-close-race');
requiredStep('postgres-integration', 'Verify assistant voids and reversals are audited in the workspace export (real PostgreSQL)',
  'node scripts/verify-billing-assistant-live.mjs');
const landingStep = requiredStep('quality', 'Landing build fails closed without legal holder variables',
  'env -u LEGAL_TITULAR_NIF -u LEGAL_TITULAR_DOMICILIO node apps/landing/build.mjs --out "$out"');
// Las dos ramas de error terminan en exit 1 y la única salida con 0 antes del build es la omisión
// mientras build.mjs no esté en la rama.
if (!/if \[ "\$status" -eq 0 \]; then\n\s*echo "::error[^\n]*\n\s*exit 1\n\s*fi/.test(landingStep.code) ||
    !/find "\$out" -name '\*\.html' \| grep -q \.; then\n\s*echo "::error[^\n]*\n\s*exit 1\n\s*fi/.test(landingStep.code)) {
  throw new Error('El paso de la landing debe salir con 1 si build.mjs termina con 0 o si deja HTML');
}
if ((landingStep.code.match(/exit 0/g) ?? []).length !== 1 ||
    !/if \[ ! -f apps\/landing\/build\.mjs \]; then\n\s*echo "::notice[^\n]*\n\s*exit 0\n\s*fi/.test(landingStep.code)) {
  throw new Error('El paso de la landing solo puede omitirse (exit 0) cuando falta apps/landing/build.mjs');
}
if (!/RACE_DATABASE_REQUIRED:\s*'1'/.test(stepsOf('postgres-integration').find((step) => step.name.startsWith('Session close race')).code)) {
  throw new Error('RACE_DATABASE_REQUIRED=1 debe ir en el propio paso session-close-race');
}

// Comprobación FUNCIONAL de la web, como la de apps/api: el comando de la CI encuentra pruebas.
let listedWebTests;
try {
  listedWebTests = execFileSync('npm', ['--workspace', '@asepsico/web', 'run', 'test', '--', '--listTests'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
  throw new Error(`El script "test" de apps/web no se pudo ejecutar: ${error.stderr || error.message}`);
}
const webTestFiles = listedWebTests.split('\n').filter((line) => line.trim().endsWith('.ts'));
if (webTestFiles.length === 0) {
  throw new Error('El script "test" de apps/web no encontró ningún archivo de test');
}

console.log(`OK: ${checks.length} comprobaciones textuales + ${testFiles.length} archivos de test de la API y ${webTestFiles.length} de la web detectados de verdad.`);
