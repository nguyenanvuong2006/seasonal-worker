import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb', // Tăng giới hạn lên 10MB
    },
  },
};

export default nextConfig;
