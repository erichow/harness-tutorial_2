import type { ContentBlock } from "../messages/blocks.js";
import type { TranscriptMessage } from "../messages/transcript.js";
import type { RuntimeEvent } from "../runtime/events.js";
import type { SessionSnapshot } from "./store.js";

/** Produce a portable, human-readable view without changing the durable JSONL source. */
export function exportSessionMarkdown(snapshot: SessionSnapshot): string {
  const { metadata } = snapshot;
  const lines = [
    `# ${metadata.name}`,
    "",
    `- Session: \`${metadata.sessionId}\``,
    `- Project: \`${metadata.projectPath}\``,
    `- Provider: \`${metadata.provider}\``,
    `- Model: \`${metadata.model}\``,
    `- Created: ${metadata.createdAt}`,
    `- Updated: ${metadata.updatedAt}`,
    ...(metadata.parentSessionId === undefined
      ? []
      : [`- Parent session: \`${metadata.parentSessionId}\``]),
    "",
    "## Conversation",
    "",
  ];

  if (snapshot.transcript.messages.length === 0) lines.push("_No messages._", "");
  for (const message of snapshot.transcript.messages) {
    lines.push(`### ${roleLabel(message)} · ${message.createdAt}`, "");
    for (const block of message.content) lines.push(...renderBlock(block), "");
  }

  lines.push("## Runtime events", "");
  if (snapshot.events.length === 0) lines.push("_No runtime events._", "");
  for (const event of snapshot.events) lines.push(`- ${renderEvent(event)}`);
  lines.push("");
  return lines.join("\n");
}

function roleLabel(message: TranscriptMessage): string {
  return {
    system: "System",
    user: "User",
    assistant: "Assistant",
    tool: "Tool",
  }[message.role];
}

function renderBlock(block: ContentBlock): string[] {
  switch (block.type) {
    case "text":
      return [block.text];
    case "reasoning_summary":
      return [`> Summary: ${block.text}`];
    case "tool_call":
      return [
        `Tool call \`${block.name}\` (\`${block.id}\`):`,
        "```json",
        JSON.stringify(block.input, null, 2),
        "```",
      ];
    case "tool_result":
      return [
        `Tool result for \`${block.toolCallId}\`: **${block.status}**`,
        "```text",
        block.content,
        "```",
      ];
  }
}

function renderEvent(event: RuntimeEvent): string {
  const prefix = `${event.timestamp} — ${event.type} (turn \`${event.turnId}\`, #${event.sequence})`;
  if (event.type === "turn_finished") return `${prefix}: ${event.reason}`;
  if (event.type === "error") return `${prefix}: ${event.category} — ${event.message}`;
  if (event.type === "tool_call_started") return `${prefix}: \`${event.call.name}\``;
  if (event.type === "tool_call_finished") return `${prefix}: ${event.result.status}`;
  return prefix;
}
