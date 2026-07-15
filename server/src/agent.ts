import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { graphMcpServer, GRAPH_TOOLS, GRAPH_PROMPT_HINT } from "./graph.js";
import { buildAgentEnv, resolveModel, usesLocalClaudeSettings } from "./ai.js";
import { activeCwd } from "./projects.js";
import type { ImageInput } from "./images.js";

/**
 * Normalized events we forward to the browser over SSE. Keeping this small and
 * flat means the frontend never has to understand the raw SDK message shapes.
 */
export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | {
      type: "result";
      subtype: string;
      text?: string;
      costUsd?: number;
      durationMs?: number;
      numTurns?: number;
    }
  | { type: "error"; message: string };

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) {
          return String((block as { text: unknown }).text ?? "");
        }
        if (block && typeof block === "object" && "content" in block) {
          return textFromContent((block as { content: unknown }).content);
        }
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * Run one user turn through the Claude Agent SDK, yielding normalized events.
 * Pass `resumeSessionId` to continue an existing conversation.
 */
/**
 * Teach the agent where its "project home" is, while keeping full host access.
 * Injected as an append to the Claude Code system-prompt preset.
 */
function workspaceGuide(cwd: string): string {
  return [
    `## Working directory & host access`,
    ``,
    `Your working directory (your "project home") is:`,
    `  ${cwd}`,
    ``,
    `- When asked to create a NEW project (e.g. a Next.js app, a script, a repo),`,
    `  scaffold it as a SUBDIRECTORY of your working directory —`,
    `  e.g. ${cwd}/<project-name>. Never create it inside this console app's own`,
    `  source tree.`,
    `- You are on a real host machine with full access. You MAY read, inspect, and`,
    `  run commands against files ANYWHERE on the machine using absolute paths when`,
    `  the user asks about code that lives outside your working directory.`,
    `- Default all NEW writes to your working directory unless the user gives an`,
    `  absolute path or explicitly asks you to work elsewhere.`,
    `- Prefer relative paths within your working directory. After scaffolding a`,
    `  project, cd into it for subsequent commands.`,
  ].join("\n");
}

export interface RunAgentOpts {
  model?: string;
  allowedTools?: string[];
  appendPrompt?: string;
  /** Expose a graphify knowledge-graph MCP tool for this working directory. */
  graphCwd?: string;
  /** Images submitted with this user turn. */
  images?: ImageInput[];
}

async function* multimodalPrompt(prompt: string, images: ImageInput[]): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    message: {
      role: "user",
      content: [
        ...images.map((image) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: image.mediaType,
            data: image.data,
          },
        })),
        { type: "text", text: prompt },
      ],
    },
    parent_tool_use_id: null,
  };
}

export async function* runAgent(
  prompt: string,
  resumeSessionId?: string,
  signal?: AbortSignal,
  cwdOverride?: string,
  opts?: RunAgentOpts
): AsyncGenerator<AgentEvent> {
  let sessionId = resumeSessionId;
  let emittedSession = false;
  // Default to the ACTIVE project's directory (imported path or its fresh
  // workspace), not the shared global workspace. Explicit overrides (e.g. an
  // isolated task workdir) still win. activeCwd() falls back to config.agentCwd
  // when no project is active.
  const cwd = cwdOverride ?? activeCwd();

  // Knowledge-graph tool for the project (if a graph exists for graphCwd).
  const mcp = opts?.graphCwd ? graphMcpServer(opts.graphCwd) : undefined;

  let append = opts?.appendPrompt
    ? `${workspaceGuide(cwd)}\n\n## Your role\n${opts.appendPrompt}`
    : workspaceGuide(cwd);
  if (mcp) append += `\n\n${GRAPH_PROMPT_HINT}`;

  // When tools are restricted, still allow the graph tools so the agent can query it.
  const allowedTools = opts?.allowedTools
    ? [...opts.allowedTools, ...(mcp ? GRAPH_TOOLS : [])]
    : undefined;

  // Provider: route through Nexotao (or fall back to SDK default auth).
  const model = resolveModel(opts?.model);

  try {
    const stream = query({
      prompt: opts?.images?.length ? multimodalPrompt(prompt, opts.images) : prompt,
      options: {
        cwd,
        resume: resumeSessionId,
        permissionMode: config.permissionMode,
        includePartialMessages: true,
        systemPrompt: { type: "preset", preset: "claude_code", append },
        env: buildAgentEnv() as Record<string, string>,
        // Nexotao: don't load ~/.claude settings, so a host provider config
        // can't hijack our routing. Claude adapter: DO load them, so the agent
        // connects exactly like the machine's own `claude` CLI.
        settingSources: usesLocalClaudeSettings() ? ["user", "project", "local"] : [],
        ...(model ? { model } : {}),
        ...(allowedTools ? { allowedTools } : {}),
        ...(mcp ? { mcpServers: mcp } : {}),
        abortController: signal ? abortControllerFrom(signal) : undefined,
      },
    });

    for await (const message of stream as AsyncIterable<any>) {
      // Capture / surface the session id as soon as we see it.
      if (message.session_id && message.session_id !== sessionId) {
        sessionId = message.session_id;
      }
      if (sessionId && !emittedSession) {
        emittedSession = true;
        yield { type: "session", sessionId };
      }

      switch (message.type) {
        case "stream_event": {
          const ev = message.event;
          if (ev?.type === "content_block_delta") {
            const delta = ev.delta;
            if (delta?.type === "text_delta" && delta.text) {
              yield { type: "text_delta", text: delta.text };
            } else if (delta?.type === "thinking_delta" && delta.thinking) {
              yield { type: "thinking_delta", text: delta.thinking };
            }
          }
          break;
        }

        case "assistant": {
          const blocks = message.message?.content ?? [];
          for (const block of blocks) {
            if (block?.type === "tool_use") {
              yield {
                type: "tool_use",
                id: block.id,
                name: block.name,
                input: block.input,
              };
            }
            // text/thinking blocks already streamed via stream_event deltas.
          }
          break;
        }

        case "user": {
          const blocks = message.message?.content ?? [];
          for (const block of blocks) {
            if (block?.type === "tool_result") {
              yield {
                type: "tool_result",
                toolUseId: block.tool_use_id,
                content: textFromContent(block.content),
                isError: Boolean(block.is_error),
              };
            }
          }
          break;
        }

        case "result": {
          yield {
            type: "result",
            subtype: message.subtype,
            text: message.result,
            costUsd: message.total_cost_usd,
            durationMs: message.duration_ms,
            numTurns: message.num_turns,
          };
          break;
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "error", message };
  }
}

function abortControllerFrom(signal: AbortSignal): AbortController {
  const ac = new AbortController();
  if (signal.aborted) ac.abort();
  else signal.addEventListener("abort", () => ac.abort(), { once: true });
  return ac;
}
