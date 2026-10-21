/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // @asepsico/contracts se publica como TypeScript sin compilar ("main": "src/index.ts"):
  // Next debe transpilarlo aunque se resuelva desde node_modules (instalación de Vercel).
  transpilePackages: ['@asepsico/contracts'],
  // Páginas públicas del alta por QR: el token va en el fragmento, pero además sin referrer y sin indexar.
  async headers() {
    const publicSignup = [
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
    ];
    return ['/portal/alta', '/portal/alta/:path*', '/portal/activar'].map((source) => ({ source, headers: publicSignup }));
  },
  async rewrites() {
    const target = process.env.API_INTERNAL_URL;
    if (!target) return [];
    return [{ source: '/api/v1/:path*', destination: `${target}/api/v1/:path*` }];
  },
};
export default nextConfig;
