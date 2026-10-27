/** @type {import('next').NextConfig} */
const nextConfig = {
  // Sitio estático (Render Static Site): `next build` genera apps/web/out. No hay servidor de
  // Next: la web llama directamente a la API en NEXT_PUBLIC_API_URL (https://api.asepsico.es/api/v1
  // en producción), sin proxy. Las rutas con id usan query string (ver lib/routes.ts).
  output: 'export',
  // Genera ruta/index.html en vez de ruta.html: cualquier hosting estático la sirve sin reglas.
  trailingSlash: true,
  // @asepsico/contracts se publica como TypeScript sin compilar ("main": "src/index.ts"):
  // Next debe transpilarlo aunque se resuelva desde node_modules.
  transpilePackages: ['@asepsico/contracts'],
  // Con `output: 'export'` Next no aplica headers() ni rewrites(): no hay servidor.
  // - Cabeceras de las páginas públicas del alta por QR (/portal/alta, /portal/activar) y del panel
  //   (/admin/*): Referrer-Policy no-referrer + X-Robots-Tag noindex, nofollow (+ Cache-Control
  //   no-store en /admin/*). Se configuran en Render → Static Site → Headers (ops/PILOT_RUNBOOK.md).
  // - Sin rewrite de /api/v1: la web llama a NEXT_PUBLIC_API_URL directamente.
};
export default nextConfig;
