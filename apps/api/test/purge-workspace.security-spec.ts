import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma } from '@prisma/client';
import { KEPT_TABLES, PURGED_USER_FIRST_NAME, PURGED_WORKSPACE_NAME } from '../prisma/scripts/demo/workspace-purge';

/**
 * db:purge-workspace sin BD: entorno, simulación por defecto, qué se conserva y vigilancia del
 * almacenamiento. La prueba completa (dos espacios, login, rollback) está en purge-workspace-db.
 */
const root = join(__dirname, '..');
const cli = readFileSync(join(root, 'prisma', 'scripts', 'purge-workspace.ts'), 'utf8');
const core = readFileSync(join(root, 'prisma', 'scripts', 'demo', 'workspace-purge.ts'), 'utf8');

describe('db:purge-workspace · reglas', () => {
  it('lo primero es exigir DEMO_ENVIRONMENT=true; sin --yes (o con --dry-run) solo simula', () => {
    const body = cli.slice(cli.indexOf('async function main()'));
    expect(body.indexOf('assertDemoEnvironment()')).toBeGreaterThan(0);
    expect(body.indexOf('assertDemoEnvironment()')).toBeLessThan(body.indexOf('new PrismaClient'));
    expect(cli).toContain("const confirmed = argv.includes('--yes') && !argv.includes('--dry-run');");
    expect(body.indexOf('if (!confirmed)')).toBeLessThan(body.indexOf('$transaction'));
  });

  it('una sola transacción con todo el borrado', () => {
    expect(cli.match(/\$transaction\(/g)).toHaveLength(1);
    expect(core).not.toMatch(/\$transaction\(/);
  });

  it('conserva solo AuditLog y TermsAcceptance; nunca los borra', () => {
    expect([...KEPT_TABLES]).toEqual(['AuditLog', 'TermsAcceptance']);
    expect(core).not.toMatch(/auditLog\.(delete|update)|termsAcceptance\.(delete|update)/);
    expect(core).not.toMatch(/model: '(auditLog|termsAcceptance)'/);
  });

  it('todos los borrados van por workspaceId (o por usuario ya comprobado de este espacio)', () => {
    const deletes = core.match(/deleteMany\(\{ where: \{[^}]*\}/g) ?? [];
    expect(deletes.length).toBeGreaterThan(0);
    for (const d of deletes) expect(d).toMatch(/workspaceId|userId: user\.id|id: user\.id, memberships: \{ none/);
    expect(core).toContain('DELETE FROM "DataRightsRequest" WHERE "workspaceId" = ${workspaceId}');
  });

  it('nombres de sustitución (Lex 24/11, §7.2)', () => {
    expect(PURGED_WORKSPACE_NAME).toBe('Espacio eliminado');
    expect(PURGED_USER_FIRST_NAME).toBe('Cuenta eliminada');
  });

  it('el CLI no imprime correos, nombres ni claves de almacenamiento', () => {
    expect(cli).not.toMatch(/workspaceName|\.email|firstName|storageKey/);
  });

  it('todos los modelos con workspaceId están en el borrado o se conservan a propósito', () => {
    const handled = new Set([...core.matchAll(/model: '(\w+)'/g)].map((m) => m[1]));
    handled.add('workspaceMember');
    for (const model of Prisma.dmmf.datamodel.models) {
      if (!model.fields.some((f) => f.name === 'workspaceId')) continue;
      const key = model.name[0].toLowerCase() + model.name.slice(1);
      if ((KEPT_TABLES as readonly string[]).includes(model.name)) continue;
      expect([model.name, handled.has(key)]).toEqual([model.name, true]);
    }
  });

  it('vigilancia: si la API empieza a guardar archivos (cliente S3 o similar), hay que ampliar el borrado', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => /aws-sdk|client-s3|^minio$|google-cloud\/storage|azure\/storage/.test(d))).toEqual([]);
  });

  it('alias en la API y en la raíz', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const rootPkg = JSON.parse(readFileSync(join(root, '..', '..', 'package.json'), 'utf8'));
    expect(pkg.scripts['db:purge-workspace']).toBe('tsx prisma/scripts/purge-workspace.ts');
    expect(rootPkg.scripts['db:purge-workspace']).toBe('npm --workspace @asepsico/api run db:purge-workspace --');
  });
});
