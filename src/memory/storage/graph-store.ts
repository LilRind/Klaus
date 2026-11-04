/**
 * 图存储契约 + 内存实现（对应书 storage/neo4j_store.py 的接口面）
 *
 * 语义记忆用它存"实体—关系—记忆"三层结构：
 * 实体节点挂 memoryIds 反查记忆，关系边带来源记忆 ID。
 * InMemoryGraphStore 供测试与轻量场景；Neo4jGraphStore 是真实后端。
 */

export interface GraphEntity {
  /** 实体规范名（去重键） */
  name: string;
  type: string;
  /** 提到该实体的记忆 ID 列表 */
  memoryIds: string[];
  properties?: Record<string, unknown>;
}

export interface GraphRelation {
  sourceName: string;
  targetName: string;
  /** 关系类型，如 RELATED_TO / WORKS_WITH */
  relation: string;
  memoryId?: string;
  properties?: Record<string, unknown>;
}

export interface GraphStore {
  init(): Promise<void>;
  /** 实体存在则合并（memoryIds 取并集），不存在则创建 */
  addEntity(entity: GraphEntity): Promise<void>;
  addRelation(relation: GraphRelation): Promise<void>;
  getEntity(name: string): Promise<GraphEntity | undefined>;
  listEntities(limit?: number): Promise<GraphEntity[]>;
  /** 与给定实体集合直接相连的关系 */
  getRelationsForEntities(names: string[], limit?: number): Promise<GraphRelation[]>;
  /** 由实体集合扩张出关联记忆 ID（图检索的核心一步） */
  getMemoryIdsForEntities(names: string[]): Promise<string[]>;
  clear(): Promise<void>;
  close?(): Promise<void>;
}

export class InMemoryGraphStore implements GraphStore {
  private readonly entities = new Map<string, GraphEntity>();
  private readonly relations: GraphRelation[] = [];

  async init(): Promise<void> {}

  async addEntity(entity: GraphEntity): Promise<void> {
    const existing = this.entities.get(entity.name);
    if (!existing) {
      this.entities.set(entity.name, {
        ...entity,
        memoryIds: [...new Set(entity.memoryIds)],
      });
      return;
    }
    existing.memoryIds = [...new Set([...existing.memoryIds, ...entity.memoryIds])];
    existing.properties = { ...existing.properties, ...entity.properties };
  }

  async addRelation(relation: GraphRelation): Promise<void> {
    this.relations.push(relation);
  }

  async getEntity(name: string): Promise<GraphEntity | undefined> {
    const entity = this.entities.get(name);
    return entity ? { ...entity, memoryIds: [...entity.memoryIds] } : undefined;
  }

  async listEntities(limit?: number): Promise<GraphEntity[]> {
    const all = [...this.entities.values()].sort(
      (a, b) => b.memoryIds.length - a.memoryIds.length,
    );
    return (limit === undefined ? all : all.slice(0, limit)).map((entity) => ({
      ...entity,
      memoryIds: [...entity.memoryIds],
    }));
  }

  async getRelationsForEntities(
    names: string[],
    limit?: number,
  ): Promise<GraphRelation[]> {
    const nameSet = new Set(names);
    const matched = this.relations.filter(
      (relation) =>
        nameSet.has(relation.sourceName) || nameSet.has(relation.targetName),
    );
    return limit === undefined ? [...matched] : matched.slice(0, limit);
  }

  async getMemoryIdsForEntities(names: string[]): Promise<string[]> {
    const memoryIds = new Set<string>();
    for (const name of names) {
      for (const id of this.entities.get(name)?.memoryIds ?? []) {
        memoryIds.add(id);
      }
    }
    // 一跳关系对端实体的记忆也算关联（图扩张）
    for (const relation of await this.getRelationsForEntities(names)) {
      const opposite =
        names.includes(relation.sourceName) ? relation.targetName : relation.sourceName;
      for (const id of this.entities.get(opposite)?.memoryIds ?? []) {
        memoryIds.add(id);
      }
      if (relation.memoryId) memoryIds.add(relation.memoryId);
    }
    return [...memoryIds];
  }

  async clear(): Promise<void> {
    this.entities.clear();
    this.relations.length = 0;
  }
}
