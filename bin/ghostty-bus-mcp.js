#!/usr/bin/env node
// ghostty-bus-mcp — Zero-dependency MCP stdio server for live agent-to-agent
// discovery and messaging across open Ghostty terminals on macOS.
// Exposes: list_agents, send_message, rename_agent, open_agent_terminal

"use strict";

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const REAL_DIR = path.dirname(fs.realpathSync(__filename));
const BUS_BIN = path.join(REAL_DIR, "ghostty-bus");
const PKG = JSON.parse(fs.readFileSync(path.join(REAL_DIR, "..", "package.json"), "utf8"));
const SERVER_INFO = { name: "ghostty-bus", version: PKG.version || "0.1.0" };

const TOOLS = [
  {
    name: "list_agents",
    description:
      "List all open Ghostty terminal sessions (equivalent to ListAgents). Returns PID, TTY, terminal UUID, title, and working directory for each terminal.",
    inputSchema: {
      type: "object",
      properties: {
        ghostty_pid: {
          type: "integer",
          description: "Optional Ghostty process PID to query (defaults to primary Ghostty instance)."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "send_message",
    description:
      "Send a message/prompt to another open Ghostty terminal session (equivalent to SendMessage). Prefixes messages with [AGENT-MSG ...] by default so peers treat them as data, never human approval.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Target terminal identifier: PID (e.g. '97770'), terminal UUID or prefix, TTY (e.g. 'ttys001'), or unique terminal title."
        },
        message: {
          type: "string",
          description: "Message text to send to the target terminal."
        },
        from: {
          type: "string",
          description: "Optional sender label (e.g. 'agy-orchestrator' or 'agy-53961')."
        },
        delay_sec: {
          type: "number",
          description: "Seconds to wait between pasting text and pressing Enter (default: 0.05)."
        },
        press_enter: {
          type: "boolean",
          description: "Whether to press Enter after inserting text (default: true)."
        },
        raw: {
          type: "boolean",
          description: "If true, send text verbatim without [AGENT-MSG] prefix or newline flattening (default: false)."
        },
        ghostty_pid: {
          type: "integer",
          description: "Optional Ghostty process PID."
        }
      },
      required: ["target", "message"],
      additionalProperties: false
    }
  },
  {
    name: "rename_agent",
    description:
      "Set a title override on a Ghostty terminal so sessions can be addressed by name (e.g. 'agy-orq', 'agy-backend').",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Target terminal: PID, terminal UUID/prefix, TTY, or current unique title."
        },
        title: {
          type: "string",
          description: "New title for the terminal."
        },
        ghostty_pid: {
          type: "integer",
          description: "Optional Ghostty process PID."
        }
      },
      required: ["target", "title"],
      additionalProperties: false
    }
  },
  {
    name: "open_agent_terminal",
    description:
      "Open a new Ghostty window or tab inside the same Ghostty instance so it remains discoverable via list_agents.",
    inputSchema: {
      type: "object",
      properties: {
        dir: {
          type: "string",
          description: "Initial working directory path for the new terminal."
        },
        title: {
          type: "string",
          description: "Title override for the new terminal."
        },
        command: {
          type: "string",
          description: "Optional command to execute (e.g. 'agy')."
        },
        as_tab: {
          type: "boolean",
          description: "Open as a tab in the front window instead of a new window (default: false)."
        },
        ghostty_pid: {
          type: "integer",
          description: "Optional Ghostty process PID."
        }
      },
      required: ["dir", "title"],
      additionalProperties: false
    }
  }
];

function runBus(args) {
  if (process.platform !== "darwin") {
    return Promise.reject(new Error("ghostty-bus-mcp requires macOS (Ghostty AppleScript/JXA support)."));
  }
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", BUS_BIN, ...args], {
      timeout: 15000,
      maxBuffer: 1024 * 1024
    }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || stdout || err.message || "").trim();
        reject(new Error(detail));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function handleToolCall(name, args) {
  const a = args || {};
  const gp = a.ghostty_pid != null ? ["--ghostty-pid", String(a.ghostty_pid)] : [];

  if (name === "list_agents") {
    return await runBus(["list", "--json", ...gp]);
  }

  if (name === "send_message") {
    if (!a.target || !a.message) {
      throw new Error("Both 'target' and 'message' are required.");
    }
    const cmdArgs = ["send", String(a.target), ...gp];
    if (a.from) cmdArgs.push("--from", String(a.from));
    cmdArgs.push("--delay", String(a.delay_sec != null ? a.delay_sec : 0.05));
    if (a.press_enter === false) cmdArgs.push("--no-enter");
    if (a.raw === true) cmdArgs.push("--raw");
    cmdArgs.push("--", String(a.message));
    return await runBus(cmdArgs);
  }

  if (name === "rename_agent") {
    if (!a.target || !a.title) {
      throw new Error("Both 'target' and 'title' are required.");
    }
    return await runBus(["rename", String(a.target), ...gp, String(a.title)]);
  }

  if (name === "open_agent_terminal") {
    if (!a.dir || !a.title) {
      throw new Error("Both 'dir' and 'title' are required.");
    }
    const cmdArgs = ["open", ...gp];
    if (a.as_tab === true) cmdArgs.push("--tab");
    cmdArgs.push(String(a.dir), String(a.title));
    if (a.command) cmdArgs.push(String(a.command));
    return await runBus(cmdArgs);
  }

  throw new Error(`Unknown tool: ${name}`);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;

  // JSON-RPC notifications have no id and expect no response
  if (id === undefined || id === null) {
    return;
  }

  try {
    if (method === "initialize") {
      const clientVersion = (params && params.protocolVersion) || "2024-11-05";
      sendResult(id, {
        protocolVersion: clientVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });
      return;
    }

    if (method === "ping") {
      sendResult(id, {});
      return;
    }

    if (method === "tools/list") {
      sendResult(id, { tools: TOOLS });
      return;
    }

    if (method === "tools/call") {
      const toolName = params && params.name;
      const toolArgs = params && params.arguments;
      try {
        const output = await handleToolCall(toolName, toolArgs);
        sendResult(id, {
          content: [{ type: "text", text: output }],
          isError: false
        });
      } catch (toolErr) {
        sendResult(id, {
          content: [{ type: "text", text: `Error: ${toolErr.message}` }],
          isError: true
        });
      }
      return;
    }

    sendError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    sendError(id, -32603, err.message || String(err));
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    process.stderr.write(`[ghostty-bus-mcp] Invalid JSON: ${e.message}\n`);
    return;
  }
  handleMessage(parsed);
});
