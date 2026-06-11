import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prevent Next.js from bundling native/CommonJS heavy packages — let Node resolve them at runtime
  serverExternalPackages: [
    "whatsapp-web.js",
    "puppeteer",
    "puppeteer-core",
    "@puppeteer/browsers",
    "qrcode-terminal",
  ],
  webpack(config, { isServer }) {
    if (!isServer) {
      // These Node built-ins are not available in the browser bundle
      config.resolve.fallback = {
        ...config.resolve.fallback,
        net: false,
        tls: false,
        fs: false,
        child_process: false,
        dgram: false,
      };
    }
    return config;
  },
};

export default nextConfig;
