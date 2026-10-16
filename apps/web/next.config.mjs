/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // @asepsico/contracts se publica como TypeScript sin compilar ("main": "src/index.ts"):
  // Next debe transpilarlo aunque se resuelva desde node_modules (instalación de Vercel).
  transpilePackages: ['@asepsico/contracts'],
  async rewrites() {
    const target = process.env.API_INTERNAL_URL;
    if (!target) return [];
    return [{ source: '/api/v1/:path*', destination: `${target}/api/v1/:path*` }];
  },
};
export default nextConfig;
