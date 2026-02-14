import type { IncomingMessage, ServerResponse } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PluginConfig {
  agentName?: string;
  agentDescription?: string;
  agentUrl?: string;
  skills?: Array<{ id: string; name: string; description: string; tags?: string[]; examples?: string[] }>;
  openness?: "open" | "approval" | "allowlist" | "closed";
  agentPagesUrl?: string;
}

interface AccessControl {
  allowlist: string[];
  blocklist: string[];
  pending: string[];
}

interface JsonRpcRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params?: any;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACCESS_FILE = join(homedir(), ".openclaw", "a2a-access.json");

function loadAccess(): AccessControl {
  try {
    if (existsSync(ACCESS_FILE)) {
      return JSON.parse(readFileSync(ACCESS_FILE, "utf-8"));
    }
  } catch {}
  return { allowlist: [], blocklist: [], pending: [] };
}

function saveAccess(ac: AccessControl): void {
  const dir = dirname(ACCESS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(ACCESS_FILE, JSON.stringify(ac, null, 2));
}

function corsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, body: any): void {
  corsHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ---------------------------------------------------------------------------
// Plugin (object export)
// ---------------------------------------------------------------------------

const a2aPlugin = {
  id: "a2a",
  name: "A2A Protocol",
  description: "Make your agent discoverable and reachable via Google's A2A protocol",

  register(api: any) {
    const pluginEntries = api.config?.plugins?.entries?.a2a?.config ?? {};
    const config: PluginConfig = pluginEntries;
    const log = api.logger ?? console;

    // -----------------------------------------------------------------------
    // 1. Agent Card — /.well-known/agent.json
    // -----------------------------------------------------------------------

    function buildAgentCard() {
      return {
        name: config.agentName ?? "OpenClaw Agent",
        description: config.agentDescription ?? "An AI agent powered by OpenClaw",
        url: config.agentUrl ?? "",
        provider: { organization: "OpenClaw" },
        version: "0.1.0",
        capabilities: {
          streaming: false,
          pushNotifications: false,
        },
        authentication: null,
        defaultInputModes: ["text"],
        defaultOutputModes: ["text"],
        skills: (config.skills ?? []).map((s) => ({
          id: s.id ?? s.name ?? "default",
          name: s.name ?? "General",
          description: s.description ?? "",
          tags: s.tags ?? [],
          examples: s.examples ?? [],
        })),
      };
    }

    api.registerHttpRoute({
      path: "/.well-known/agent.json",
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === "OPTIONS") {
          corsHeaders(res);
          res.writeHead(204);
          res.end();
          return;
        }
        jsonResponse(res, 200, buildAgentCard());
      },
    });

    // -----------------------------------------------------------------------
    // 2. Access control check
    // -----------------------------------------------------------------------

    function checkAccess(senderUrl: string | undefined): { allowed: boolean; reason?: string } {
      const openness = config.openness ?? "open";

      if (openness === "open") return { allowed: true };
      if (openness === "closed") return { allowed: false, reason: "This agent is not accepting A2A messages." };

      const ac = loadAccess();
      const sender = senderUrl ?? "unknown";

      if (ac.blocklist.includes(sender)) {
        return { allowed: false, reason: "You are blocked from contacting this agent." };
      }

      if (openness === "allowlist") {
        return ac.allowlist.includes(sender)
          ? { allowed: true }
          : { allowed: false, reason: "You are not on the allowlist for this agent." };
      }

      // approval mode
      if (ac.allowlist.includes(sender)) return { allowed: true };

      if (!ac.pending.includes(sender)) {
        ac.pending.push(sender);
        saveAccess(ac);
      }

      return { allowed: false, reason: "Your request is pending approval. The agent owner has been notified." };
    }

    // -----------------------------------------------------------------------
    // 3. A2A JSON-RPC endpoint — /a2a
    // -----------------------------------------------------------------------

    api.registerHttpRoute({
      path: "/a2a",
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === "OPTIONS") {
          corsHeaders(res);
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method !== "POST") {
          jsonResponse(res, 405, jsonRpcError(null, -32600, "Method not allowed. Use POST."));
          return;
        }

        let rpc: JsonRpcRequest;
        try {
          const body = await readBody(req);
          rpc = JSON.parse(body);
        } catch {
          jsonResponse(res, 400, jsonRpcError(null, -32700, "Parse error"));
          return;
        }

        if (rpc.jsonrpc !== "2.0" || !rpc.method) {
          jsonResponse(res, 400, jsonRpcError(rpc?.id ?? null, -32600, "Invalid JSON-RPC request"));
          return;
        }

        const senderUrl = rpc.params?.metadata?.sender ?? rpc.params?.sender;
        const access = checkAccess(senderUrl);
        if (!access.allowed) {
          jsonResponse(res, 200, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: { status: "rejected", reason: access.reason },
          });
          return;
        }

        switch (rpc.method) {
          case "message/send": {
            const parts = rpc.params?.message?.parts ?? [];
            const textParts = parts
              .filter((p: any) => p.type === "text" || p.kind === "text" || typeof p.text === "string")
              .map((p: any) => p.text ?? p.content ?? "")
              .join("\n");

            const agentName = config.agentName ?? "OpenClaw Agent";

            log.info(`[A2A] Received message/send from ${senderUrl ?? "unknown"}: ${textParts.slice(0, 100)}`);

            jsonResponse(res, 200, {
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                status: "completed",
                artifacts: [
                  {
                    parts: [
                      {
                        type: "text",
                        text: `Hello! I'm ${agentName}. I received your message: "${textParts.slice(0, 200)}". ` +
                          `This agent is powered by OpenClaw with the A2A plugin. Full conversational routing is coming soon.`,
                      },
                    ],
                  },
                ],
              },
            });
            return;
          }

          default:
            jsonResponse(res, 200, jsonRpcError(rpc.id, -32601, `Method not found: ${rpc.method}`));
        }
      },
    });

    // -----------------------------------------------------------------------
    // 4. Agent tools — a2a_discover & a2a_message
    // -----------------------------------------------------------------------

    api.registerTool({
      name: "a2a_discover",
      label: "A2A Discover",
      description:
        "Discover an A2A-compatible agent by fetching its Agent Card. " +
        "Provide the agent's base URL (the card is fetched from /.well-known/agent.json).",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Base URL of the agent (e.g. https://agent.example.com)",
          },
        },
        required: ["url"],
      },
      async execute(_toolCallId: string, params: { url: string }) {
        const cardUrl = params.url.replace(/\/$/, "") + "/.well-known/agent.json";
        try {
          const resp = await fetch(cardUrl);
          if (!resp.ok) return toolResult(`Failed to fetch agent card: HTTP ${resp.status}`);
          const card = await resp.json();
          return toolResult(card);
        } catch (err: any) {
          return toolResult(`Error discovering agent: ${err.message}`);
        }
      },
    });

    api.registerTool({
      name: "a2a_message",
      label: "A2A Message",
      description:
        "Send an A2A message to another agent. " +
        "Provide the agent's base URL and the message text.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Base URL of the target agent",
          },
          message: {
            type: "string",
            description: "Message text to send",
          },
        },
        required: ["url", "message"],
      },
      async execute(_toolCallId: string, params: { url: string; message: string }) {
        const endpoint = params.url.replace(/\/$/, "") + "/a2a";
        const senderUrl = config.agentUrl ?? "unknown";

        const rpcPayload = {
          jsonrpc: "2.0",
          id: Date.now().toString(),
          method: "message/send",
          params: {
            message: {
              role: "user",
              parts: [{ type: "text", text: params.message }],
            },
            metadata: { sender: senderUrl },
          },
        };

        try {
          const resp = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(rpcPayload),
          });
          const result = await resp.json();
          return toolResult(result);
        } catch (err: any) {
          return toolResult(`Error sending A2A message: ${err.message}`);
        }
      },
    });

    // -----------------------------------------------------------------------
    // 5. CLI commands — openclaw a2a
    // -----------------------------------------------------------------------

    api.registerCli?.(
      ({ program }: any) => {
        const a2aCmd = program
          .command("a2a")
          .description("Manage A2A protocol settings and access control");

        a2aCmd
          .command("status")
          .description("Show A2A configuration and access lists")
          .action(() => {
            const ac = loadAccess();
            console.log(`A2A Protocol Plugin v0.1.0\n`);
            console.log(`Agent Name:    ${config.agentName ?? "(not set)"}`);
            console.log(`Description:   ${config.agentDescription ?? "(not set)"}`);
            console.log(`Public URL:    ${config.agentUrl ?? "(not set)"}`);
            console.log(`Openness:      ${config.openness ?? "open"}`);
            console.log(`Skills:        ${(config.skills ?? []).length}`);
            console.log(`\nAllowlist (${ac.allowlist.length}):`);
            ac.allowlist.forEach((u) => console.log(`  - ${u}`));
            console.log(`Blocklist (${ac.blocklist.length}):`);
            ac.blocklist.forEach((u) => console.log(`  - ${u}`));
            console.log(`Pending (${ac.pending.length}):`);
            ac.pending.forEach((u) => console.log(`  - ${u}`));
          });

        a2aCmd
          .command("allow <url>")
          .description("Add a URL to the allowlist")
          .action((url: string) => {
            const ac = loadAccess();
            if (!ac.allowlist.includes(url)) ac.allowlist.push(url);
            ac.pending = ac.pending.filter((u) => u !== url);
            ac.blocklist = ac.blocklist.filter((u) => u !== url);
            saveAccess(ac);
            console.log(`Added ${url} to allowlist.`);
          });

        a2aCmd
          .command("block <url>")
          .description("Add a URL to the blocklist")
          .action((url: string) => {
            const ac = loadAccess();
            if (!ac.blocklist.includes(url)) ac.blocklist.push(url);
            ac.pending = ac.pending.filter((u) => u !== url);
            ac.allowlist = ac.allowlist.filter((u) => u !== url);
            saveAccess(ac);
            console.log(`Added ${url} to blocklist.`);
          });

        a2aCmd
          .command("pending")
          .description("Show pending approval requests")
          .action(() => {
            const ac = loadAccess();
            if (ac.pending.length === 0) {
              console.log("No pending approval requests.");
              return;
            }
            console.log("Pending approval requests:");
            ac.pending.forEach((u) => console.log(`  - ${u}`));
          });
      },
      { commands: ["a2a"] },
    );

    log.info("[A2A] Plugin activated — Agent Card at /.well-known/agent.json, endpoint at /a2a");
  },
};

export default a2aPlugin;
