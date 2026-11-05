import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Use the existing Tailwind loader for Webpack as well as Turbopack so
  // production fallback builds actually generate the same utility styles.
  webpack(config) {
    config.module.rules.push({
      test: /[/\\]app[/\\]globals\.css$/,
      enforce: "pre",
      use: [{ loader: "@tailwindcss/turbopack" }],
    });
    return config;
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
