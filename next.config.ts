import type {NextConfig} from 'next';

/**
 * Dual-Mode Build.
 *
 *   NEXT_BUILD_TARGET=static  →  `output: 'export'` + basePath  (GitHub Pages)
 *   sonst                     →  `output: 'standalone'`          (AI Studio / Cloud Run)
 *
 * Der GitHub-Actions-Workflow (.github/workflows/deploy-pages.yml) setzt die
 * Variable. Dadurch bleibt der bestehende AI-Studio-Deploy-Pfad exakt so, wie
 * er war — Pages ist rein additiv.
 *
 * Der basePath ist nötig, weil Project-Pages unter
 * https://<user>.github.io/<repo>/ liegen, nicht unter der Wurzel.
 */
const STATIC = process.env.NEXT_BUILD_TARGET === 'static';
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ['*.europe-west2.run.app', '*.run.app'],
  turbopack: {},
  typescript: {
    ignoreBuildErrors: false,
  },
  // Statischer Export kann keine On-the-fly-Bildoptimierung — und dieses Projekt
  // rendert ohnehin auf ein <canvas>, es gibt keine next/image-Pipeline.
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'picsum.photos',
        port: '',
        pathname: '/**',
      },
    ],
  },
  output: STATIC ? 'export' : 'standalone',
  ...(STATIC && BASE_PATH ? {basePath: BASE_PATH, assetPrefix: BASE_PATH} : {}),
  transpilePackages: ['motion'],
  webpack: (config, {dev}) => {
    // HMR is disabled in AI Studio via DISABLE_HMR env var.
    // Do not modify — file watching is disabled to prevent flickering during agent edits.
    if (dev && process.env.DISABLE_HMR === 'true') {
      config.watchOptions = {
        ignored: /.*/
      };
    }
    return config;
  },
};

export default nextConfig;
