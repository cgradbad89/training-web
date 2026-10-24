import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  env: {
    // Share the deployment identity with client and server gate evaluations.
    NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV: process.env.VERCEL_ENV ?? "",
  },
  // Avoid Next inferring an unrelated parent lockfile as the Turbopack root.
  turbopack: {
    root: repositoryRoot,
  },
  // Keep Next's production build aligned with the repository typecheck gate.
  typescript: {
    tsconfigPath: "tsconfig.build.json",
  },
};

export default nextConfig;
