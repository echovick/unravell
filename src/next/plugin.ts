import { spawn, ChildProcess } from "child_process";
import * as http from "http";
import type { Configuration } from "webpack";

interface NextConfig {
  webpack?: (config: Configuration, options: any) => Configuration;
  [key: string]: any;
}

const UNRAVEL_PORT = parseInt(process.env.UNRAVEL_PORT || "4839", 10);

function withUnravel(nextConfig: NextConfig = {}): NextConfig {
  // Only run in development
  if (process.env.NODE_ENV !== "development") return nextConfig;

  let serverProcess: ChildProcess | null = null;
  let serverStarted = false;

  function startServer() {
    if (serverStarted) return;
    serverStarted = true;

    // Check if server is already running (e.g., from a previous HMR cycle)
    checkServerHealth().then((alive) => {
      if (alive) {
        console.log(`[Unravel] Analysis server already running on port ${UNRAVEL_PORT}`);
        return;
      }

      try {
        serverProcess = spawn(
          "node",
          [require.resolve("@echovick/unravel/dist/server")],
          {
            env: {
              ...process.env,
              UNRAVEL_PROJECT_ROOT: process.cwd(),
              UNRAVEL_PORT: String(UNRAVEL_PORT),
            },
            stdio: "pipe",
            detached: false,
          }
        );

        serverProcess.stdout?.on("data", (data: Buffer) => {
          const msg = data.toString().trim();
          if (msg) console.log(`[Unravel] ${msg}`);
        });

        serverProcess.stderr?.on("data", (data: Buffer) => {
          const msg = data.toString().trim();
          if (msg) console.error(`[Unravel] ${msg}`);
        });

        serverProcess.on("error", (err) => {
          console.error(`[Unravel] Failed to start server: ${err.message}`);
          serverStarted = false;
        });

        serverProcess.on("exit", (code) => {
          if (code !== 0 && code !== null) {
            console.error(`[Unravel] Server exited with code ${code}`);
          }
          serverProcess = null;
          serverStarted = false;
        });

        // Clean up on process exit
        const cleanup = () => {
          if (serverProcess && !serverProcess.killed) {
            serverProcess.kill("SIGTERM");
          }
        };
        process.on("exit", cleanup);
        process.on("SIGINT", () => { cleanup(); process.exit(0); });
        process.on("SIGTERM", () => { cleanup(); process.exit(0); });
      } catch (err: any) {
        console.error(`[Unravel] Could not start server: ${err.message}`);
        serverStarted = false;
      }
    });
  }

  return {
    ...nextConfig,
    webpack(config: Configuration, options: any) {
      // Start server on first server-side webpack build
      if (options.isServer) {
        startServer();
      }

      // Inject the client-setup script into the client bundle
      if (!options.isServer) {
        const originalEntry = config.entry as
          | (() => Promise<Record<string, string[]>>)
          | Record<string, string[]>;

        config.entry = async () => {
          const entries =
            typeof originalEntry === "function"
              ? await originalEntry()
              : originalEntry;

          // Try known Next.js entry points
          const clientEntries = ["main-app", "main"];
          for (const entryName of clientEntries) {
            if (entries[entryName] && Array.isArray(entries[entryName])) {
              try {
                const clientSetupPath = require.resolve("@echovick/unravel/dist/client-setup");
                if (!entries[entryName].includes(clientSetupPath)) {
                  entries[entryName].unshift(clientSetupPath);
                }
              } catch {
                // Resolve failed — package not properly installed
              }
              break;
            }
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

function checkServerHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${UNRAVEL_PORT}/health`, (res) => {
      resolve(res.statusCode === 200);
      res.resume(); // consume the response
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

export = withUnravel;
