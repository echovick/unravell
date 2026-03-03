import { spawn, ChildProcess } from "child_process";
import type { Configuration } from "webpack";

interface NextConfig {
  webpack?: (config: Configuration, options: any) => Configuration;
  [key: string]: any;
}

function withUnravel(nextConfig: NextConfig = {}): NextConfig {
  // Only run in development
  if (process.env.NODE_ENV !== "development") return nextConfig;

  let serverProcess: ChildProcess | null = null;

  return {
    ...nextConfig,
    webpack(config: Configuration, options: any) {
      if (options.isServer && !serverProcess) {
        // Start analysis server on first webpack build
        serverProcess = spawn(
          "node",
          [require.resolve("unravel/dist/server")],
          {
            env: {
              ...process.env,
              UNRAVEL_PROJECT_ROOT: process.cwd(),
              UNRAVEL_PORT: "4839",
            },
            stdio: "pipe",
            detached: false,
          }
        );

        serverProcess.stdout?.on("data", (data: Buffer) => {
          console.log(`[Unravel] ${data}`);
        });

        serverProcess.stderr?.on("data", (data: Buffer) => {
          console.error(`[Unravel] ${data}`);
        });
      }

      // Inject the error boundary wrapper into the client bundle
      if (!options.isServer) {
        const originalEntry = config.entry as () => Promise<Record<string, string[]>>;
        config.entry = async () => {
          const entries = await originalEntry();
          if (entries["main-app"]) {
            entries["main-app"].unshift(
              require.resolve("unravel/dist/client-setup")
            );
          }
          return entries;
        };
      }

      return typeof nextConfig.webpack === "function"
        ? nextConfig.webpack(config, options)
        : config;
    },
  };
}

module.exports = withUnravel;
export default withUnravel;
