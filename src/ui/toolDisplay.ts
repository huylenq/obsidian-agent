import { ToolBlock } from "@/types";

export type ToolStatus = "running" | "error" | "done";

const MCP_REGEX = /^mcp__([^_]+)__(.+)$/;

export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const m = name.match(MCP_REGEX);
  return m ? { server: m[1], tool: m[2] } : null;
}

export function displayToolName(name: string): string {
  const mcp = parseMcpToolName(name);
  return mcp ? `${mcp.server} / ${mcp.tool}` : name;
}

export function getBlockStatus(block: ToolBlock): ToolStatus {
  if (block.isError) return "error";
  if (block.isRunning) return "running";
  return "done";
}

export function getGroupStatus(blocks: ToolBlock[]): ToolStatus {
  let running = false;
  for (const b of blocks) {
    if (b.isError) return "error";
    if (b.isRunning) running = true;
  }
  return running ? "running" : "done";
}
