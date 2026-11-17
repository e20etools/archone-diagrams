import { fileURLToPath, pathToFileURL, URL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

type Env = Record<string, string | undefined>;
type Handle = (request: Request) => Promise<Response>;

/** Runs a web-standard handler (Request in, Response out) behind Node's connect middleware. */
function serve(getHandler: () => Promise<Handle>, path = "/api/ai") {
  return (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request(`http://${req.headers.host ?? "localhost"}${path}`, {
        method: req.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
      });
      getHandler()
        .then((handle) => handle(request))
        .then(async (response) => {
          res.statusCode = response.status;
          response.headers.forEach((value, name) => res.setHeader(name, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        })
        .catch(() => {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "server_error" }));
        });
    });
  };
}

/**
 * Serves /api/ai locally so AI drafting can be tried before hosting.
 * `vite dev` runs the current source; `vite preview` runs api/ai.js, the exact file Vercel deploys.
 */
function localAiEndpoint(env: Env): Plugin {
  return {
    name: "archone-local-ai-endpoint",
    configureServer(server) {
      server.middlewares.use(
        "/api/ai",
        serve(async () => {
          const http = (await server.ssrLoadModule("/src/lib/ai/http.ts")) as typeof import("./src/lib/ai/http");
          return http.createAiHandler(() => env);
        }),
      );
      server.middlewares.use(
        "/api/apm",
        serve(async () => {
          const http = (await server.ssrLoadModule("/src/lib/apm/http.ts")) as typeof import("./src/lib/apm/http");
          return http.createApmHandler(() => env);
        }, "/api/apm"),
      );
    },
    configurePreviewServer(server) {
      // The bundled function reads process.env, as it does on the host.
      for (const [name, value] of Object.entries(env)) {
        if (/^(AI_|ANTHROPIC_|OPENAI_|GROQ_|LOVABLE_|APM_)/.test(name) && process.env[name] === undefined) process.env[name] = value;
      }
      const bundle = pathToFileURL(fileURLToPath(new URL("./api/ai.js", import.meta.url))).href;
      server.middlewares.use(
        "/api/ai",
        serve(async () => {
          const module = (await import(/* @vite-ignore */ bundle)) as { default: { fetch: Handle } };
          return module.default.fetch;
        }),
      );
      const apm = pathToFileURL(fileURLToPath(new URL("./api/apm.js", import.meta.url))).href;
      server.middlewares.use(
        "/api/apm",
        serve(async () => {
          const module = (await import(/* @vite-ignore */ apm)) as { default: { fetch: Handle } };
          return module.default.fetch;
        }, "/api/apm"),
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  // Server-side keys (no VITE_ prefix) are read here for the local endpoint only; they never reach the browser bundle.
  const env: Env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), tailwindcss(), localAiEndpoint(env)],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC") },
    server: { host: "::", port: 8080 },
    preview: { host: "::", port: 8080 },
    build: { chunkSizeWarningLimit: 900 },
    test: { environment: "node", include: ["src/**/*.test.ts"] },
  };
});
