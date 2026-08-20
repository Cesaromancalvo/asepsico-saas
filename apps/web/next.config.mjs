/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  async rewrites() {
    const target = process.env.API_INTERNAL_URL;
    if (!target) return [];
    return [{ source: '/api/v1/:path*', destination: `${target}/api/v1/:path*` }];
  },
};
export default nextConfig;
