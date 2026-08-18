#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { CawApi } from "./api.js"
import { TOOLS, WRITE_TOOLS, handleToolCall, getWriteConfig } from "./tools.js"

function log(msg: string) {
  process.stderr.write(`[caw-mcp] ${msg}\n`)
}

const server = new Server(
  { name: "caw-protocol", version: "1.0.0" },
  { capabilities: { tools: {} } },
)

const api = new CawApi()
const writeConfig = getWriteConfig()
const writeEnabled = writeConfig !== null

log(`API: ${process.env.CAW_API_URL || "https://caw.is"}`)
log(`Mode: ${writeEnabled ? `read+write (sender=${writeConfig!.senderId})` : "read-only"}`)
log(`Tools: ${TOOLS.length} read${writeEnabled ? ` + ${WRITE_TOOLS.length} write` : ""}`)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: writeEnabled ? [...TOOLS, ...WRITE_TOOLS] : TOOLS,
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  log(`→ ${request.params.name}`)
  const result = await handleToolCall(api, request.params.name, request.params.arguments ?? {})
  if (result.isError) log(`✗ ${request.params.name}: ${(result.content[0] as any)?.text}`)
  return result
})

const transport = new StdioServerTransport()
await server.connect(transport)
