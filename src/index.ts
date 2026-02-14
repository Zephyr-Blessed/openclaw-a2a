import type { IncomingMessage, ServerResponse } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TrustLevel = "blocked" | "open" | "skilled" | "friend";

interface PluginConfig {
  agentName?: string;
  agentDescription?: string;
  agentUrl?: string;
  skills?: Array<{ id: string; name: string; description: string; tags?: string[]; examples?: string[] }>;
  defaultTrust?: TrustLevel | "approval";
  notifyOwner?: "always" | "actions" | "never";
  sessionTimeout?: number;
  maxTaskTTL?: number;
  rateLimitPerMinute?: number;
  auth?: { mode?: string; apiKeys?: Record<string, string> };
  agentPagesUrl?: string;
  // legacy
  openness?: string;
}

interface Contact {
  name?: string;
  trust: TrustLevel;
  tools?: string[];
  skills?: string[];
  notes?: string;
}

interface ContactsFile {
  defaultTrust: TrustLevel | "approval";
  contacts: Record<string, Contact>;
  pending: string[];
}

interface TaskMessage {
  role: "user" | "agent";
  text: string;
  timestamp: string;
}

interface Task {
  id: string;
  sender: string;
  trust: TrustLevel;
  skill?: string;
  sessionKey?: string;
  status: "submitted" | "working" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  messages: TaskMessage[];
  artifacts: any[];
}

interface TasksFile {
  tasks: Record<string, Task>;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params?: any;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

const OPENCLAW_DIR = join(homedir(), ".openclaw");
const CONTACTS_FILE = join(OPENCLAW_DIR, "a2a-contacts.json");
const TASKS_FILE = join(OPENCLAW_DIR, "a2a-tasks.json");
const LEGACY_ACCESS_FILE = join(OPENCLAW_DIR, "a2a-access.json");

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadContacts(): ContactsFile {
  try {
    if (existsSync(CONTACTS_FILE)) {
      return JSON.parse(readFileSync(CONTACTS_FILE, "utf-8"));
    }
  } catch {}

  // Migrate from legacy access file if it exists
  const defaults: ContactsFile = { defaultTrust: "open", contacts: {}, pending: [] };
  try {
    if (existsSync(LEGACY_ACCESS_FILE)) {
      const legacy = JSON.parse(readFileSync(LEGACY_ACCESS_FILE, "utf-8"));
      if (Array.isArray(legacy.allowlist)) {
        for (const url of legacy.allowlist) {
          defaults.contacts[url] = { trust: "open" };
        }
      }
      if (Array.isArray(legacy.blocklist)) {
        for (const url of legacy.blocklist) {
          defaults.contacts[url] = { trust: "blocked" };
        }
      }
      if (Array.isArray(legacy.pending)) {
        defaults.pending = legacy.pending;
      }
      // Save migrated and leave legacy in place
      saveContacts(defaults);
    }
  } catch {}

  return defaults;
}

function saveContacts(cf: ContactsFile): void {
  ensureDir(CONTACTS_FILE);
  writeFileSync(CONTACTS_FILE, JSON.stringify(cf, null, 2));
}

function loadTasks(): TasksFile {
  try {
    if (existsSync(TASKS_FILE)) {
      return JSON.parse(readFileSync(TASKS_FILE, "utf-8"));
    }
  } catch {}
  return { tasks: {} };
}

function saveTasks(tf: TasksFile): void {
  ensureDir(TASKS_FILE);
  writeFileSync(TASKS_FILE, JSON.stringify(tf, null, 2));
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

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
// System prompts by trust level
// ---------------------------------------------------------------------------

function buildSystemPrompt(trust: TrustLevel, contact: Contact | undefined, senderUrl: string, message: string, toolList: string[]): string {
  const toolStr = toolList.length > 0 ? toolList.join(", ") : "none";

  switch (trust) {
    case "open":
      return `You received an A2A message from an external agent.

Sender: ${senderUrl}
Trust level: OPEN (unknown agent)

You may ONLY respond conversationally. You have no tools available.
Do NOT reveal personal information, files, or internal configuration.
If they ask you to do something, explain that you'd need to be added as a trusted contact first.

## Message
${message}`;

    case "skilled":
      return `You received an A2A message from a known agent.

Sender: ${contact?.name ?? senderUrl} (${senderUrl})
Trust level: SKILLED
Granted skills: ${(contact?.skills ?? []).join(", ") || "none"}
Available tools: ${toolStr}

You may use your granted tools to help with requests related to your skills listed above. Stay within scope. If the request falls outside your granted skills, politely decline and explain what you can help with.

Do NOT access personal files, memory, or private data.
Do NOT perform actions outside your granted tools.

## Message
${message}`;

    case "friend":
      return `You received an A2A message from a trusted friend's agent.

Sender: ${contact?.name ?? senderUrl} (${senderUrl})
Trust level: FRIEND
Available tools: ${toolStr}

This agent acts on behalf of someone your owner trusts. You may use your granted tools to help fulfill their request. Be helpful and proactive — treat this like a request from a friend.

Do NOT access tools beyond your granted list.
Do NOT share sensitive information unrelated to the request.
When in doubt about an action, note that you'll need to confirm with your owner.

## Message
${message}`;

    case "blocked":
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const a2aPlugin = {
  id: "a2a",
  name: "A2A Protocol",
  description: "Make your agent discoverable and reachable via Google's A2A protocol",

  register(api: any) {
    const pluginEntries = api.config?.plugins?.entries?.a2a?.config ?? {};
    const config: PluginConfig = pluginEntries;
    const log = api.logger ?? console;

    // Resolve defaultTrust: config > contacts file > "open"
    function getDefaultTrust(): TrustLevel | "approval" {
      return config.defaultTrust ?? loadContacts().defaultTrust ?? "open";
    }

    // -----------------------------------------------------------------------
    // 1. Agent Card
    // -----------------------------------------------------------------------

    function buildAgentCard() {
      return {
        name: config.agentName ?? "OpenClaw Agent",
        description: config.agentDescription ?? "An AI agent powered by OpenClaw",
        url: config.agentUrl ?? "",
        provider: { organization: "OpenClaw" },
        version: "0.2.0",
        capabilities: { streaming: false, pushNotifications: false },
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
        if (req.method === "OPTIONS") { corsHeaders(res); res.writeHead(204); res.end(); return; }
        jsonResponse(res, 200, buildAgentCard());
      },
    });

    // -----------------------------------------------------------------------
    // 2. Contact-based trust check
    // -----------------------------------------------------------------------

    function resolveTrust(senderUrl: string | undefined): { trust: TrustLevel | "pending"; contact?: Contact; reason?: string } {
      const sender = senderUrl ?? "unknown";
      const cf = loadContacts();

      // Known contact
      if (cf.contacts[sender]) {
        const contact = cf.contacts[sender];
        if (contact.trust === "blocked") {
          return { trust: "blocked", contact, reason: "You are blocked from contacting this agent." };
        }
        return { trust: contact.trust, contact };
      }

      // Unknown — check default
      const dt = getDefaultTrust();

      if (dt === "blocked") {
        return { trust: "blocked", reason: "This agent is not accepting A2A messages." };
      }

      if (dt === "approval") {
        // Add to pending
        if (!cf.pending.includes(sender)) {
          cf.pending.push(sender);
          saveContacts(cf);
        }
        return { trust: "pending", reason: "Your request is pending approval. The agent owner has been notified." };
      }

      // dt is a trust level — apply it as default for unknown senders
      return { trust: dt as TrustLevel };
    }

    // -----------------------------------------------------------------------
    // 3. Task management
    // -----------------------------------------------------------------------

    function createTask(senderUrl: string, trust: TrustLevel, message: string, skill?: string): Task {
      const tf = loadTasks();
      const task: Task = {
        id: randomUUID(),
        sender: senderUrl,
        trust,
        skill,
        status: "submitted",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [{ role: "user", text: message, timestamp: new Date().toISOString() }],
        artifacts: [],
      };
      tf.tasks[task.id] = task;
      saveTasks(tf);
      return task;
    }

    function updateTask(taskId: string, update: Partial<Task>): Task | null {
      const tf = loadTasks();
      if (!tf.tasks[taskId]) return null;
      Object.assign(tf.tasks[taskId], update, { updatedAt: new Date().toISOString() });
      saveTasks(tf);
      return tf.tasks[taskId];
    }

    function getTask(taskId: string): Task | null {
      return loadTasks().tasks[taskId] ?? null;
    }

    // -----------------------------------------------------------------------
    // 4. Owner notification helper
    // -----------------------------------------------------------------------

    function notifyOwner(message: string): void {
      const mode = config.notifyOwner ?? "actions";
      if (mode === "never") return;
      try {
        if (typeof api.runtime?.notify === "function") {
          api.runtime.notify(message);
        } else if (typeof api.runtime?.sendSystemEvent === "function") {
          api.runtime.sendSystemEvent(message);
        } else {
          log.info(`[A2A] Owner notification: ${message}`);
        }
      } catch (err: any) {
        log.warn(`[A2A] Failed to notify owner: ${err.message}`);
      }
    }

    // -----------------------------------------------------------------------
    // 5. Message handler — process A2A messages with trust-based routing
    // -----------------------------------------------------------------------

    async function handleMessageSend(rpc: JsonRpcRequest, res: ServerResponse): Promise<void> {
      const senderUrl: string = rpc.params?.metadata?.sender ?? rpc.params?.sender ?? "unknown";
      const parts = rpc.params?.message?.parts ?? [];
      const textParts = parts
        .filter((p: any) => p.type === "text" || p.kind === "text" || typeof p.text === "string")
        .map((p: any) => p.text ?? p.content ?? "")
        .join("\n");

      // Trust check
      const { trust, contact, reason } = resolveTrust(senderUrl);

      if (trust === "blocked" || trust === "pending") {
        jsonResponse(res, 200, {
          jsonrpc: "2.0", id: rpc.id,
          result: { status: "rejected", reason },
        });
        return;
      }

      // Determine granted tools
      const grantedTools: string[] = trust === "open" ? [] : (contact?.tools ?? []);

      // Multi-turn: check for existing taskId
      const existingTaskId: string | undefined = rpc.params?.taskId;
      let task: Task;

      if (existingTaskId) {
        const existing = getTask(existingTaskId);
        if (!existing) {
          jsonResponse(res, 200, jsonRpcError(rpc.id, -32602, `Task not found: ${existingTaskId}`));
          return;
        }
        if (existing.sender !== senderUrl) {
          jsonResponse(res, 200, jsonRpcError(rpc.id, -32602, "Task sender mismatch"));
          return;
        }
        // Append message to existing task
        existing.messages.push({ role: "user", text: textParts, timestamp: new Date().toISOString() });
        existing.status = "working";
        updateTask(existing.id, { messages: existing.messages, status: "working" });
        task = existing;
      } else {
        task = createTask(senderUrl, trust as TrustLevel, textParts, rpc.params?.skill);
      }

      log.info(`[A2A] Task ${task.id} | ${trust} | from ${senderUrl}: ${textParts.slice(0, 100)}`);

      // Build system prompt
      const systemPrompt = buildSystemPrompt(trust as TrustLevel, contact, senderUrl, textParts, grantedTools);

      // Attempt to route through the runtime for a real LLM response
      let responseText: string | null = null;

      try {
        // Try api.runtime.complete — a simple LLM completion call if available
        if (typeof api.runtime?.complete === "function") {
          const result = await api.runtime.complete({
            systemPrompt,
            messages: task.messages.map((m) => ({ role: m.role === "agent" ? "assistant" : "user", content: m.text })),
            tools: grantedTools,
          });
          responseText = typeof result === "string" ? result : result?.text ?? result?.content ?? null;
        }
        // Try api.runtime.sendAndWait — session-based approach
        else if (typeof api.runtime?.sendAndWait === "function") {
          const result = await api.runtime.sendAndWait({
            systemPrompt,
            message: textParts,
            tools: grantedTools,
            sessionKey: `a2a-task-${task.id}`,
          });
          responseText = typeof result === "string" ? result : result?.text ?? null;
          task.sessionKey = `a2a-task-${task.id}`;
        }
        // Try api.runtime.spawn for isolated sessions
        else if (typeof api.runtime?.spawn === "function") {
          const session = await api.runtime.spawn({
            systemPrompt,
            tools: grantedTools,
            sessionKey: `a2a-task-${task.id}`,
          });
          if (session && typeof session.send === "function") {
            const result = await session.send(textParts);
            responseText = typeof result === "string" ? result : result?.text ?? null;
            task.sessionKey = `a2a-task-${task.id}`;
          }
        }
      } catch (err: any) {
        log.warn(`[A2A] Runtime routing failed: ${err.message}`);
      }

      // Fallback: generate a trust-aware static response
      if (!responseText) {
        const agentName = config.agentName ?? "OpenClaw Agent";
        if (trust === "open") {
          responseText = `Hello! I'm ${agentName}. I received your message. ` +
            `I can chat with you but don't have tools available for your requests. ` +
            `If you need me to take actions, ask my owner to add you as a trusted contact.`;
        } else if (trust === "skilled") {
          responseText = `Hello! I'm ${agentName}. I received your message and I'm a skilled-level contact. ` +
            `I have access to tools: [${grantedTools.join(", ")}] for skills: [${(contact?.skills ?? []).join(", ")}]. ` +
            `Note: Full LLM-routed responses require runtime session support (not yet available). ` +
            `Your task has been stored as ${task.id}.`;
        } else {
          responseText = `Hello! I'm ${agentName}. I received your message as a friend-level contact. ` +
            `I have access to tools: [${grantedTools.join(", ")}]. ` +
            `Note: Full LLM-routed responses require runtime session support (not yet available). ` +
            `Your task has been stored as ${task.id}.`;
        }
      }

      // Store response
      task.messages.push({ role: "agent", text: responseText, timestamp: new Date().toISOString() });
      task.artifacts = [{ parts: [{ type: "text", text: responseText }] }];
      task.status = "completed";
      updateTask(task.id, { messages: task.messages, artifacts: task.artifacts, status: "completed", sessionKey: task.sessionKey });

      // Notify owner for friend-level actions
      if (trust === "friend") {
        notifyOwner(`🤝 A2A: ${contact?.name ?? senderUrl} sent a message — task ${task.id}\n> ${textParts.slice(0, 200)}`);
      }

      jsonResponse(res, 200, {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          id: task.id,
          status: task.status,
          artifacts: task.artifacts,
        },
      });
    }

    // -----------------------------------------------------------------------
    // 6. A2A JSON-RPC endpoint — /a2a
    // -----------------------------------------------------------------------

    api.registerHttpRoute({
      path: "/a2a",
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === "OPTIONS") { corsHeaders(res); res.writeHead(204); res.end(); return; }
        if (req.method !== "POST") {
          jsonResponse(res, 405, jsonRpcError(null, -32600, "Method not allowed. Use POST."));
          return;
        }

        let rpc: JsonRpcRequest;
        try {
          rpc = JSON.parse(await readBody(req));
        } catch {
          jsonResponse(res, 400, jsonRpcError(null, -32700, "Parse error"));
          return;
        }

        if (rpc.jsonrpc !== "2.0" || !rpc.method) {
          jsonResponse(res, 400, jsonRpcError(rpc?.id ?? null, -32600, "Invalid JSON-RPC request"));
          return;
        }

        switch (rpc.method) {
          case "message/send":
            return handleMessageSend(rpc, res);

          case "tasks/get": {
            const taskId = rpc.params?.id;
            const task = taskId ? getTask(taskId) : null;
            if (!task) {
              jsonResponse(res, 200, jsonRpcError(rpc.id, -32602, "Task not found"));
              return;
            }
            jsonResponse(res, 200, { jsonrpc: "2.0", id: rpc.id, result: task });
            return;
          }

          default:
            jsonResponse(res, 200, jsonRpcError(rpc.id, -32601, `Method not found: ${rpc.method}`));
        }
      },
    });

    // -----------------------------------------------------------------------
    // 7. Agent tools — a2a_discover & a2a_message (kept as-is)
    // -----------------------------------------------------------------------

    api.registerTool({
      name: "a2a_discover",
      label: "A2A Discover",
      description: "Discover an A2A-compatible agent by fetching its Agent Card. Provide the agent's base URL.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Base URL of the agent" } },
        required: ["url"],
      },
      async execute(_toolCallId: string, params: { url: string }) {
        const cardUrl = params.url.replace(/\/$/, "") + "/.well-known/agent.json";
        try {
          const resp = await fetch(cardUrl);
          if (!resp.ok) return toolResult(`Failed to fetch agent card: HTTP ${resp.status}`);
          return toolResult(await resp.json());
        } catch (err: any) {
          return toolResult(`Error discovering agent: ${err.message}`);
        }
      },
    });

    api.registerTool({
      name: "a2a_message",
      label: "A2A Message",
      description: "Send an A2A message to another agent. Provide the agent's base URL and message text.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Base URL of the target agent" },
          message: { type: "string", description: "Message text to send" },
        },
        required: ["url", "message"],
      },
      async execute(_toolCallId: string, params: { url: string; message: string }) {
        const endpoint = params.url.replace(/\/$/, "") + "/a2a";
        const senderUrl = config.agentUrl ?? "unknown";
        try {
          const resp = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: Date.now().toString(),
              method: "message/send",
              params: {
                message: { role: "user", parts: [{ type: "text", text: params.message }] },
                metadata: { sender: senderUrl },
              },
            }),
          });
          return toolResult(await resp.json());
        } catch (err: any) {
          return toolResult(`Error sending A2A message: ${err.message}`);
        }
      },
    });

    // -----------------------------------------------------------------------
    // 8. CLI commands
    // -----------------------------------------------------------------------

    api.registerCli?.(
      ({ program }: any) => {
        const a2a = program.command("a2a").description("Manage A2A protocol, contacts, and tasks");

        // --- status ---
        a2a.command("status").description("Show A2A configuration and stats").action(() => {
          const cf = loadContacts();
          const tf = loadTasks();
          const taskCount = Object.keys(tf.tasks).length;
          const contactCount = Object.keys(cf.contacts).length;
          console.log(`A2A Protocol Plugin v0.2.0\n`);
          console.log(`Agent Name:     ${config.agentName ?? "(not set)"}`);
          console.log(`Description:    ${config.agentDescription ?? "(not set)"}`);
          console.log(`Public URL:     ${config.agentUrl ?? "(not set)"}`);
          console.log(`Default Trust:  ${getDefaultTrust()}`);
          console.log(`Notify Owner:   ${config.notifyOwner ?? "actions"}`);
          console.log(`Skills:         ${(config.skills ?? []).length}`);
          console.log(`Contacts:       ${contactCount}`);
          console.log(`Pending:        ${cf.pending.length}`);
          console.log(`Tasks:          ${taskCount}`);
        });

        // --- contacts ---
        a2a.command("contacts").description("List all contacts").action(() => {
          const cf = loadContacts();
          const entries = Object.entries(cf.contacts);
          if (entries.length === 0) { console.log("No contacts."); return; }
          for (const [url, c] of entries) {
            const tools = c.tools?.length ? ` tools=[${c.tools.join(",")}]` : "";
            const skills = c.skills?.length ? ` skills=[${c.skills.join(",")}]` : "";
            console.log(`  ${c.trust.padEnd(8)} ${c.name ?? url}${tools}${skills}`);
            if (c.name) console.log(`           ${url}`);
          }
        });

        // --- add ---
        a2a.command("add <url>").description("Add a contact")
          .option("--trust <level>", "Trust level", "open")
          .option("--tools <tools>", "Comma-separated tool names")
          .option("--skills <skills>", "Comma-separated skill ids")
          .option("--name <name>", "Display name")
          .action((url: string, opts: any) => {
            const cf = loadContacts();
            const trust = opts.trust as TrustLevel;
            if (!["blocked", "open", "skilled", "friend"].includes(trust)) {
              console.error(`Invalid trust level: ${trust}. Use: blocked, open, skilled, friend`);
              return;
            }
            cf.contacts[url] = {
              trust,
              ...(opts.name && { name: opts.name }),
              ...(opts.tools && { tools: opts.tools.split(",").map((t: string) => t.trim()) }),
              ...(opts.skills && { skills: opts.skills.split(",").map((s: string) => s.trim()) }),
            };
            cf.pending = cf.pending.filter((u) => u !== url);
            saveContacts(cf);
            console.log(`Added ${url} as ${trust}.`);
          });

        // --- trust ---
        a2a.command("trust <url> <level>").description("Change trust level").action((url: string, level: string) => {
          if (!["blocked", "open", "skilled", "friend"].includes(level)) {
            console.error(`Invalid trust level: ${level}`); return;
          }
          const cf = loadContacts();
          if (!cf.contacts[url]) { cf.contacts[url] = { trust: level as TrustLevel }; }
          else { cf.contacts[url].trust = level as TrustLevel; }
          saveContacts(cf);
          console.log(`Set ${url} to ${level}.`);
        });

        // --- grant ---
        a2a.command("grant <url> <tools...>").description("Grant tools to a contact").action((url: string, tools: string[]) => {
          const cf = loadContacts();
          if (!cf.contacts[url]) { console.error(`Contact not found: ${url}`); return; }
          const c = cf.contacts[url];
          c.tools = [...new Set([...(c.tools ?? []), ...tools])];
          saveContacts(cf);
          console.log(`Granted [${tools.join(", ")}] to ${url}. Tools: [${c.tools.join(", ")}]`);
        });

        // --- revoke ---
        a2a.command("revoke <url> <tools...>").description("Revoke tools from a contact").action((url: string, tools: string[]) => {
          const cf = loadContacts();
          if (!cf.contacts[url]) { console.error(`Contact not found: ${url}`); return; }
          const c = cf.contacts[url];
          c.tools = (c.tools ?? []).filter((t) => !tools.includes(t));
          saveContacts(cf);
          console.log(`Revoked [${tools.join(", ")}] from ${url}. Tools: [${c.tools.join(", ")}]`);
        });

        // --- block ---
        a2a.command("block <url>").description("Block a contact").action((url: string) => {
          const cf = loadContacts();
          cf.contacts[url] = { ...(cf.contacts[url] ?? {}), trust: "blocked" };
          cf.pending = cf.pending.filter((u) => u !== url);
          saveContacts(cf);
          console.log(`Blocked ${url}.`);
        });

        // --- unblock ---
        a2a.command("unblock <url>").description("Unblock a contact (sets to open)").action((url: string) => {
          const cf = loadContacts();
          if (cf.contacts[url]) {
            cf.contacts[url].trust = "open";
            saveContacts(cf);
            console.log(`Unblocked ${url} (set to open).`);
          } else {
            console.log(`Contact not found: ${url}`);
          }
        });

        // --- pending ---
        a2a.command("pending").description("Show pending approval requests").action(() => {
          const cf = loadContacts();
          if (cf.pending.length === 0) { console.log("No pending requests."); return; }
          console.log("Pending approval requests:");
          cf.pending.forEach((u) => console.log(`  - ${u}`));
        });

        // --- approve ---
        a2a.command("approve <url>").description("Approve a pending contact")
          .option("--trust <level>", "Trust level", "open")
          .option("--tools <tools>", "Comma-separated tool names")
          .action((url: string, opts: any) => {
            const cf = loadContacts();
            if (!cf.pending.includes(url) && !cf.contacts[url]) {
              console.error(`${url} is not pending.`); return;
            }
            const trust = opts.trust as TrustLevel;
            cf.contacts[url] = {
              ...(cf.contacts[url] ?? {}),
              trust,
              ...(opts.tools && { tools: opts.tools.split(",").map((t: string) => t.trim()) }),
            };
            cf.pending = cf.pending.filter((u) => u !== url);
            saveContacts(cf);
            console.log(`Approved ${url} as ${trust}.`);
          });

        // --- reject ---
        a2a.command("reject <url>").description("Reject a pending contact").action((url: string) => {
          const cf = loadContacts();
          cf.pending = cf.pending.filter((u) => u !== url);
          cf.contacts[url] = { ...(cf.contacts[url] ?? {}), trust: "blocked" };
          saveContacts(cf);
          console.log(`Rejected and blocked ${url}.`);
        });

        // --- tasks ---
        a2a.command("tasks").description("List recent tasks")
          .option("--limit <n>", "Number of tasks to show", "10")
          .action((opts: any) => {
            const tf = loadTasks();
            const tasks = Object.values(tf.tasks)
              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
              .slice(0, parseInt(opts.limit) || 10);
            if (tasks.length === 0) { console.log("No tasks."); return; }
            for (const t of tasks) {
              console.log(`  ${t.status.padEnd(10)} ${t.id.slice(0, 8)} ${t.trust.padEnd(8)} ${t.sender} (${t.messages.length} msgs) ${t.createdAt}`);
            }
          });
      },
      { commands: ["a2a"] },
    );

    log.info("[A2A] Plugin v0.2.0 activated — contacts-based trust system, task routing");
  },
};

export default a2aPlugin;
