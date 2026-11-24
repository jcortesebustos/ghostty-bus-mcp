"use strict";

const assert = require("assert");
const { spawnSync } = require("child_process");
const path = require("path");

const serverPath = path.join(__dirname, "..", "bin", "ghostty-bus-mcp.js");

const requests = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "1.0.0" }
    }
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "ping" },
  { jsonrpc: "2.0", id: 3, method: "tools/list" },
  { jsonrpc: "2.0", id: 4, method: "nonexistent/method" }
];

const res = spawnSync(process.execPath, [serverPath], {
  input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
  encoding: "utf8",
  timeout: 10000
});

assert.strictEqual(res.status, 0, `Expected exit 0, got ${res.status}. stderr: ${res.stderr}`);

const responses = res.stdout
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

assert.strictEqual(responses.length, 4, `Expected 4 JSON-RPC responses, got ${responses.length}`);

// 1. initialize
assert.strictEqual(responses[0].id, 1);
assert.strictEqual(responses[0].result.protocolVersion, "2025-03-26");
assert.strictEqual(responses[0].result.serverInfo.name, "ghostty-bus");

// 2. ping
assert.strictEqual(responses[1].id, 2);
assert.deepStrictEqual(responses[1].result, {});

// 3. tools/list
assert.strictEqual(responses[2].id, 3);
const toolNames = responses[2].result.tools.map((t) => t.name).sort();
assert.deepStrictEqual(toolNames, [
  "list_agents",
  "open_agent_terminal",
  "rename_agent",
  "send_message"
]);

// 4. unknown method
assert.strictEqual(responses[3].id, 4);
assert.strictEqual(responses[3].error.code, -32601);

console.log("OK: MCP protocol smoke test passed (4/4 assertions).");
