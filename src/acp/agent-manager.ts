/**
 * Spawn and manage ACP agent subprocesses.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import packageJson from "../../package.json" with { type: "json" };
import type { WeChatAcpClient } from "./client.js";
import { trackException } from "../telemetry/index.js";

export interface AgentProcessInfo {
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  sessionId: string;
}

export async function spawnAgent(params: {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  client: WeChatAcpClient;
  log: (msg: string) => void;
}): Promise<AgentProcessInfo> {
  const { command, args, cwd, env, client, log } = params;

  // On Windows, shell mode avoids EINVAL/ENOENT for command shims like npx/claude/gemini.
  const useShell = process.platform === "win32";

  log(`Spawning agent: ${command} ${args.join(" ")} (cwd: ${cwd}, shell=${useShell})`);

  const proc = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    cwd,
    env: { ...process.env, ...env },
    shell: useShell,
    windowsHide: true,
  });

  proc.on("error", (err) => {
    log(`Agent process error: ${String(err)}`);
    trackException(err, "agent_spawn");
  });

  proc.on("exit", (code, signal) => {
    log(`Agent process exited: code=${code} signal=${signal}`);
  });

  if (!proc.stdin || !proc.stdout) {
    proc.kill();
    const err = new Error("Failed to get agent process stdio");
    trackException(err, "agent_spawn");
    throw err;
  }

  const input = Writable.toWeb(proc.stdin);
  const output = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  const connection = new acp.ClientSideConnection(() => client, stream);

  // Initialize
  log("Initializing ACP connection...");
  const initResult = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: {
      name: packageJson.name,
      title: packageJson.name,
      version: packageJson.version,
    },
    clientCapabilities: {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    },
  });
  log(`ACP initialized (protocol v${initResult.protocolVersion})`);

  // Create session
  log("Creating ACP session...");
  const sessionResult = await connection.newSession({
    cwd,
    mcpServers: [],
  });
  log(`ACP session created: ${sessionResult.sessionId}`);

  return {
    process: proc,
    connection,
    sessionId: sessionResult.sessionId,
  };
}

export function killAgent(proc: ChildProcess): void {
  const pid = proc.pid;
  if (!pid) {
    if (!proc.killed) proc.kill("SIGTERM");
    return;
  }

  killProcessTree(pid, "SIGTERM");
  setTimeout(() => killProcessTree(pid, "SIGKILL"), 5_000).unref();
}

function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  for (const childPid of childPids(pid)) {
    killProcessTree(childPid, signal);
  }

  try {
    process.kill(pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      throw err;
    }
  }
}

function childPids(pid: number): number[] {
  if (process.platform === "win32") return [];

  try {
    const out = execFileSync("pgrep", ["-P", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return [];
    return out.split(/\s+/).map((value) => Number(value)).filter(Number.isFinite);
  } catch {
    return [];
  }
}
