import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // 启用 forbidden() / unauthorized() —— /admin 非 admin 返回真 HTTP 403
    authInterrupts: true,
  },
};

export default nextConfig;
