/**
 * s18 Swarm 任务板（来源：SN p2p.go SwarmTask CRUD + depends_on）。
 * 进程内最小实现：pending/in_progress/completed/cancelled 四态 + owner。
 */

export type SwarmTaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface SwarmTask {
  id: string;
  description: string;
  dependsOn: string[];
  status: SwarmTaskStatus;
  owner?: string;
}

export class TaskBoardStore {
  private readonly tasks = new Map<string, SwarmTask>();

  create(task: { id: string; description: string; dependsOn?: string[] }): SwarmTask {
    if (this.tasks.has(task.id)) throw new Error(`任务 id 重复：${task.id}`);
    const record: SwarmTask = {
      id: task.id,
      description: task.description,
      dependsOn: task.dependsOn ?? [],
      status: "pending",
    };
    this.tasks.set(task.id, record);
    return record;
  }

  update(id: string, description: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    task.description = description;
    return true;
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status === "completed" || task.status === "cancelled") return false;
    task.status = "cancelled";
    return true;
  }

  claim(id: string, owner: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== "pending") return false;
    task.status = "in_progress";
    task.owner = owner;
    return true;
  }

  complete(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    task.status = "completed";
    return true;
  }

  get(id: string): SwarmTask | undefined {
    return this.tasks.get(id);
  }

  list(): SwarmTask[] {
    return [...this.tasks.values()];
  }

  pending(): SwarmTask[] {
    return this.list().filter((task) => task.status === "pending");
  }

  /** 给 LLM 的紧凑摘要。 */
  snapshot(): string {
    if (this.tasks.size === 0) return "（任务板为空）";
    return this.list()
      .map((task) => `${task.id} [${task.status}]${task.owner ? ` owner=${task.owner}` : ""} ${task.description}`)
      .join("\n");
  }
}
