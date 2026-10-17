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
};
export default nextConfig;
