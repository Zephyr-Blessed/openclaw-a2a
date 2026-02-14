# OpenClaw A2A Plugin

Make your OpenClaw agent discoverable and reachable via Google's [A2A (Agent-to-Agent) protocol](https://google.github.io/A2A/).

This is the first A2A plugin for OpenClaw — enabling any OpenClaw-powered agent to participate in the open agent interoperability ecosystem.

## What it does

- **Serves an Agent Card** at `/.well-known/agent.json` so other agents can discover you
- **Exposes an A2A JSON-RPC endpoint** at `/a2a` for receiving messages from other agents
- **Access control** — choose who can message your agent: open, approval-based, allowlist, or closed
- **Agent tools** — `a2a_discover` and `a2a_message` let your agent find and talk to other A2A agents
- **CLI management** — `openclaw a2a status/allow/block/pending` for access control

## Installation

```bash
openclaw plugins install /path/to/openclaw-a2a-plugin
```

## Configuration

Configure the plugin in your OpenClaw settings:

| Setting | Description |
|---------|-------------|
| `agentName` | Your agent's name in the A2A Agent Card |
| `agentDescription` | Description of what your agent does |
| `agentUrl` | Public URL of your OpenClaw gateway |
| `skills` | Array of skills to advertise (`[{ id, name, description }]`) |
| `openness` | Access level: `open`, `approval`, `allowlist`, or `closed` |
| `agentPagesUrl` | AgentPages directory URL for auto-registration (future) |

## How other agents can reach you

Once configured, other A2A-compatible agents can:

1. **Discover** your agent by fetching `https://your-gateway.com/.well-known/agent.json`
2. **Send messages** via POST to `https://your-gateway.com/a2a` with JSON-RPC 2.0:

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [{ "type": "text", "text": "Hello!" }]
    }
  }
}
```

## CLI Commands

```bash
openclaw a2a status    # Show config and access lists
openclaw a2a allow <url>  # Add agent URL to allowlist
openclaw a2a block <url>  # Block an agent URL
openclaw a2a pending      # Show pending approval requests
```

## Access Control

| Mode | Behavior |
|------|----------|
| `open` | Accept messages from any agent |
| `approval` | New senders go to pending; owner gets notified |
| `allowlist` | Only pre-approved agents can message |
| `closed` | Reject all A2A messages |

Access lists are stored at `~/.openclaw/a2a-access.json`.

## Agent Tools

Your agent gets two new tools:

- **`a2a_discover`** — Fetch another agent's Agent Card from their URL
- **`a2a_message`** — Send a message to another agent's A2A endpoint

## Links

- [A2A Protocol Specification](https://google.github.io/A2A/)
- [AgentPages Directory](https://agentpages.org)
- [OpenClaw](https://openclaw.com)

## License

MIT
