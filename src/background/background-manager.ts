/**
 * 后台任务（对齐 learn-claude-code s11）
 *
 * 慢命令显式标记 run_in_background 后由 BackgroundManager 接管：
 * 当前工具调用立刻返回占位结果（bg_id），Agent Loop 继续运行；
 * 命令在子进程里执行，完成后进入就绪队列，下一轮 LLM 调用前以
 * <task_notification> 独立 user 消息注入（不复用 tool_use_id——
 * 一个 tool_call 仍只对应一条 tool 消息）。
 *
 * 进程树清理是尽力而为的生命周期管理（Windows taskkill /T、POSIX
 * 进程组），不是沙箱——与 lcc 口径一致。
 */

import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { decodeShellOutput } from "../tools/shell-output";

export interface BashProcessResult {
  output: string;
  exitCode: number | null;
}

export interface RunBashProcessOptions {
  cwd: string;
  /** 单命令超时毫秒，默认 120_000（对齐 s11） */
  timeoutMs?: number;
  /** 输出截断字符数，默认 50_000 */
  maxOutputChars?: number;
  /** 进程登记回调（BackgroundManager 用于 dispose 清理） */
  onProcess?: (child: ChildProcess) => void;
}

export interface BackgroundTask {
  toolCallId?: string;
  command: string;
  status: "running" | "completed" | "failed";
}

/**
 * 尽力终止进程树（对齐 lcc _stop_process_group）：
 * Windows 无进程组信号 → taskkill /T /F；POSIX → 对 detached 进程组发 SIGTERM。
 */
export function stopProcessTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
    } catch {
      // 尽力而为：taskkill 不可用时退回 child.kill()
      child.kill();
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // 进程已退出
    }
  }
}

/** spawn 执行单条命令（shell 语义对齐 lcc _run_bash_process；同步路径不走这里） */
export async function runBashProcess(
  command: string,
  options: RunBashProcessOptions,
): Promise<BashProcessResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputChars = options.maxOutputChars ?? 50_000;

  return await new Promise<BashProcessResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, {
        shell: true,
        cwd: options.cwd,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({
        output: `Error: ${error instanceof Error ? error.constructor.name : String(error)}: ${error instanceof Error ? error.message : String(error)}`,
        exitCode: null,
      });
      return;
    }
    if (child.pid === undefined) {
      resolve({ output: "Error: failed to spawn shell process", exitCode: null });
      return;
    }

    options.onProcess?.(child);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    /** override 非 null 时直接采用（timeout / spawn error 的错误文案优先于部分输出） */
    const finish = (override: string | null, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
    const merged = `${decodeShellOutput(Buffer.concat(stdoutChunks))}${decodeShellOutput(
      Buffer.concat(stderrChunks),
    )}`.trim();
      const text =
        override ?? (merged || "(no output)").slice(0, maxOutputChars);
      resolve({ output: text, exitCode });
    };

    const timer = setTimeout(() => {
      stopProcessTree(child);
      finish(`Error: Timeout (${Math.round(timeoutMs / 1000)}s)`, null);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk); // 原始字节累积：避免多字节字符被 chunk 边界截断
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      finish(`Error: ${error.constructor.name}: ${error.message}`, null);
    });
    child.on("close", (code) => {
      finish(null, code);
    });
  });
}

/** 非零退出码加 Error 前缀（对齐 lcc _format_bash_result；null 视为无错误前缀） */
export function formatBashResult(output: string, exitCode: number | null): string {
  if (exitCode === 0 || exitCode === null) {
    return output;
  }
  return `Error: command exited with status ${exitCode}\n${output}`;
}

export interface BackgroundManagerOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

/** 通知 summary 截断（对齐 lcc result[:500]） */
const NOTIFICATION_SUMMARY_LIMIT = 500;

export class BackgroundManager {
  /** 运行中/已完成任务（collect 后出队删除，对齐 lcc） */
  readonly tasks = new Map<string, BackgroundTask>();
  private readonly results = new Map<string, string>();
  private readonly ready: string[] = [];
  private readonly completions = new Map<string, Promise<void>>();
  private readonly processes = new Set<ChildProcess>();
  private counter = 0;
  private disposed = false;

  constructor(private readonly options: BackgroundManagerOptions) {}

  /** 登记后台命令并立即返回 bg_id（fire-and-forget，对齐 lcc start） */
  async start(command: string, toolCallId?: string): Promise<string> {
    if (typeof command !== "string" || !command.trim()) {
      throw new Error("Bash command cannot be empty");
    }
    this.counter += 1;
    const taskId = `bg_${String(this.counter).padStart(4, "0")}`;
    this.tasks.set(taskId, { toolCallId, command, status: "running" });
    this.completions.set(
      taskId,
      this.run(taskId, command).then(() => undefined),
    );
    return taskId;
  }

  /** 等待指定任务完成（测试与宿主同步用；collect 后仍可等待） */
  async waitFor(taskId: string): Promise<void> {
    const completion = this.completions.get(taskId);
    if (!completion) {
      throw new Error(`Unknown background task: ${taskId}`);
    }
    await completion;
  }

  private async run(taskId: string, command: string): Promise<void> {
    let result: string;
    let status: BackgroundTask["status"];
    try {
      const { output, exitCode } = await runBashProcess(command, {
        cwd: this.options.cwd,
        timeoutMs: this.options.timeoutMs,
        maxOutputChars: this.options.maxOutputChars,
        onProcess: (child) => {
          this.processes.add(child);
          child.on("close", () => this.processes.delete(child));
        },
      });
      result = formatBashResult(output, exitCode);
      status = exitCode === 0 ? "completed" : "failed";
    } catch (error) {
      result = `Error: ${error instanceof Error ? error.constructor.name : String(error)}: ${error instanceof Error ? error.message : String(error)}`;
      status = "failed";
    }
    if (this.disposed) return;
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = status;
    this.results.set(taskId, result);
    this.ready.push(taskId);
  }

  /** 收集完成结果并格式化为通知（破坏性出队：每个结果只投递一次） */
  collect(): string[] {
    if (this.ready.length === 0) return [];
    const ready = this.ready.splice(0, this.ready.length);
    const notifications: string[] = [];
    for (const taskId of ready) {
      const task = this.tasks.get(taskId);
      const result = this.results.get(taskId) ?? "";
      this.tasks.delete(taskId);
      this.results.delete(taskId);
      if (!task) continue;
      notifications.push(
        `<task_notification>\n` +
          `  <task_id>${taskId}</task_id>\n` +
          `  <status>${task.status}</status>\n` +
          `  <command>${task.command}</command>\n` +
          `  <summary>${result.slice(0, NOTIFICATION_SUMMARY_LIMIT)}</summary>\n` +
          `</task_notification>`,
      );
    }
    return notifications;
  }

  /**
   * 非破坏 peek：是否有已完成、未投递的结果（s15 自动唤醒 tick 判定用）。
   * 与 collect() 消费同一 ready 队列，但不出队——唤醒轮内仍由既有
   * 通知管线破坏性收集，恰好各消费一次。
   */
  hasCompleted(): boolean {
    return this.ready.length > 0;
  }

  /**
   * 是否仍有后台任务在跑（s17 goal defer 判据）：关键结果还没回到
   * 对话时立即判断没有意义，Goal gate 应 defer 而不是评估。
   */
  hasRunning(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === "running") return true;
    }
    return false;
  }

  /** 尽力清理：终止仍在运行的进程树并停止后续登记（生命周期清理，非沙箱） */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const child of [...this.processes]) {
      stopProcessTree(child);
    }
    // 等待被终止的进程退出（上限 2s，避免宿主退出路径挂死）
    const deadline = Date.now() + 2_000;
    while (this.processes.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.processes.clear();
    this.tasks.clear();
    this.results.clear();
    this.ready.length = 0;
  }
}
