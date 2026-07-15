import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Graphify integration — gives agents a persistent, queryable knowledge graph
 * of the project they're working in, so they can ask the graph about code
 * structure instead of grepping blindly every time.
 *
 * The graph is built structurally (AST only — free, deterministic, no LLM) and
 * served to agents over MCP via `graphify.serve` (stdio). Requires graphify to
 * be installed with the `mcp` extra (`uv tool install graphifyy --with mcp`).
 */

let pythonPath: string | null | undefined;

function resolvePython(): string | null {
  if (pythonPath !== undefined) return pythonPath;
  pythonPath = null;
  const marker = join(process.cwd(), "..", "graphify-out", ".graphify_python");
  if (existsSync(marker)) {
    const p = readFileSync(marker, "utf8").trim();
    if (p && canImport(p)) pythonPath = p;
  }
  if (!pythonPath) {
    const which = spawnSyncSafe("bash", ["-lc", "command -v graphify"]);
    const bin = which.trim();
    if (bin && existsSync(bin)) {
      const shebang = readFileSync(bin, "utf8").split("\n")[0].replace(/^#!/, "").trim();
      if (shebang && /^[\w/.@-]+$/.test(shebang) && canImport(shebang)) pythonPath = shebang;
    }
  }
  if (!pythonPath && canImport("python3")) pythonPath = "python3";
  return pythonPath;
}

function spawnSyncSafe(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000 });
  return (r.stdout || "").toString();
}

function canImport(py: string): boolean {
  const r = spawnSync(py, ["-c", "import graphify"], { encoding: "utf8", timeout: 8000 });
  return r.status === 0;
}

let serveOk: boolean | undefined;
/** Does the resolved interpreter have the `mcp` package (needed for graphify.serve)? */
function serveAvailable(): boolean {
  if (serveOk !== undefined) return serveOk;
  const py = resolvePython();
  serveOk = !!py && spawnSync(py, ["-c", "import mcp"], { encoding: "utf8", timeout: 8000 }).status === 0;
  return serveOk;
}

export function initGraph(): void {
  if (!config.graphEnabled) {
    console.log("[graph] disabled (GRAPH_ENABLED=false)");
    return;
  }
  const py = resolvePython();
  if (!py) {
    console.log("[graph] graphify not found — knowledge-graph tool disabled (install: uv tool install graphifyy --with mcp)");
  } else if (!serveAvailable()) {
    console.log("[graph] graphify found but the `mcp` extra is missing — graph builds, but agents get no query tool (install: uv tool install graphifyy --with mcp)");
  } else {
    console.log("[graph] graphify available — agents get a knowledge-graph tool");
  }
}

export function graphAvailable(): boolean {
  return config.graphEnabled && resolvePython() !== null;
}

function graphJsonPath(cwd: string): string {
  return join(cwd, "graphify-out", "graph.json");
}

export function graphExists(cwd: string): boolean {
  return existsSync(graphJsonPath(cwd));
}

/* ------------------------------------------------------------------ */
/* Build / refresh (non-blocking, best-effort, AST-only)              */
/* ------------------------------------------------------------------ */

const inFlight = new Map<string, Promise<void>>();

export function ensureGraph(cwd: string): Promise<void> {
  if (!graphAvailable()) return Promise.resolve();
  const existing = inFlight.get(cwd);
  if (existing) return existing;

  const py = resolvePython()!;
  const exists = existsSync(graphJsonPath(cwd));

  const run = new Promise<void>((resolve) => {
    const child = exists
      ? spawn("graphify", ["update", cwd, "--no-viz"], { stdio: "ignore" })
      : spawn(py, ["-c", STRUCTURAL_BUILD, cwd], { stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), exists ? 60000 : 150000);
    child.on("error", (e) => {
      console.warn("[graph] ensureGraph spawn error:", e.message);
      clearTimeout(timer);
      resolve();
    });
    child.on("exit", () => {
      clearTimeout(timer);
      if (!exists && existsSync(graphJsonPath(cwd))) console.log(`[graph] structural graph ready for ${cwd}`);
      resolve();
    });
  }).finally(() => inFlight.delete(cwd));

  inFlight.set(cwd, run);
  return run;
}

/* ------------------------------------------------------------------ */
/* MCP server (graphify.serve over stdio) exposing graph query tools  */
/* ------------------------------------------------------------------ */

/** MCP server config for the graph of `cwd`, or undefined if unavailable. */
export function graphMcpServer(cwd: string): Record<string, { command: string; args: string[] }> | undefined {
  if (!graphAvailable() || !serveAvailable()) return undefined;
  const gp = graphJsonPath(cwd);
  if (!existsSync(gp)) return undefined;
  return { graphify: { command: resolvePython()!, args: ["-m", "graphify.serve", gp] } };
}

/** Tool names graphify.serve exposes — allowlist these for restricted agents. */
export const GRAPH_TOOLS = [
  "mcp__graphify__query_graph",
  "mcp__graphify__get_node",
  "mcp__graphify__get_neighbors",
  "mcp__graphify__get_community",
  "mcp__graphify__god_nodes",
  "mcp__graphify__graph_stats",
  "mcp__graphify__shortest_path",
];

export const GRAPH_PROMPT_HINT =
  "## Project knowledge graph\n" +
  "You have a `graphify` knowledge-graph tool (`mcp__graphify__*`) that maps this project's code — " +
  "functions, calls, imports, and cross-file relationships. Before grepping or reading many files to " +
  "understand how things fit together, query it: `god_nodes` (core abstractions), `query_graph` (search), " +
  "`get_neighbors` (what connects to X), `shortest_path` (how A relates to B), `get_community` (a module " +
  "cluster), `graph_stats`. Use it to orient fast, then read only the files you need. If it returns " +
  "nothing, the graph may be sparse — fall back to reading.";

/** Inline Python: detect code files, AST-extract, build, cluster, write graph.json. No LLM. */
const STRUCTURAL_BUILD = `
import sys, json
from pathlib import Path
from graphify.detect import detect
from graphify.extract import collect_files, extract as ast_extract
from graphify.build import build_from_json
from graphify.cluster import cluster
from graphify.export import to_json
cwd = sys.argv[1]
det = detect(Path(cwd))
code = []
for f in det.get('files', {}).get('code', []):
    code.extend(collect_files(Path(f)) if Path(f).is_dir() else [Path(f)])
if not code:
    print('no code files'); sys.exit(0)
ast = ast_extract(code, cache_root=Path(cwd))
if not ast.get('nodes'):
    print('empty'); sys.exit(0)
G = build_from_json(ast, root=cwd, directed=False)
comms = cluster(G)
out = Path(cwd) / 'graphify-out' / 'graph.json'
out.parent.mkdir(parents=True, exist_ok=True)
to_json(G, comms, str(out))
print(f'{G.number_of_nodes()} nodes, {G.number_of_edges()} edges')
`;
