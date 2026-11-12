import type { NextConfig } from "next";

// Next blocks cross-origin dev assets by default. The cloud preview hostname is
// supplied at dev-server start, so it is configured through the environment
// instead of being hardcoded in this tracked file. Production is unaffected.
const allowedDevOrigins = (process.env.NEXT_ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: process.cwd(),
  },
  ...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),
};

export default nextConfig;
