/**
 * Neo4j 图存储真实后端（对应书 8.1.4 storage/neo4j_store.py）
 *
 * 语义记忆的知识图谱：(:MemoryEntity {name, type, memoryIds})
 * -[:MEMORY_RELATION {type, memoryId}]-。
 * 与 InMemoryGraphStore 同一 GraphStore 接口，可无缝替换。
 * 实体合并用 MERGE（memoryIds 数组追加去重，对应书里的图谱构建）。
 */

import neo4j, { type Driver, type Session } from "neo4j-driver";
import type {
  GraphEntity,
  GraphRelation,
  GraphStore,
} from "./graph-store";

export interface Neo4jStoreOptions {
  uri: string;
  username: string;
  password: string;
  database?: string;
  /** 测试可注入驱动 */
  driver?: Driver;
}

export class Neo4jGraphStore implements GraphStore {
  private driver?: Driver;
  private readonly options: Neo4jStoreOptions;

  constructor(options: Neo4jStoreOptions) {
    this.options = options;
  }

  /** 建连 + 实体名唯一约束（对应书 "Neo4j索引创建完成"） */
  async init(): Promise<void> {
    await this.withSession(async (session) => {
      await session.run(
        "CREATE CONSTRAINT entity_name_unique IF NOT EXISTS " +
          "FOR (e:MemoryEntity) REQUIRE e.name IS UNIQUE",
      );
    });
    await this.getDriver().verifyConnectivity();
  }

  private getDriver(): Driver {
    this.driver ??=
      this.options.driver ??
      neo4j.driver(
        this.options.uri,
        neo4j.auth.basic(this.options.username, this.options.password),
      );
    return this.driver;
  }

  private async withSession<T>(
    operation: (session: Session) => Promise<T>,
  ): Promise<T> {
    const session = this.getDriver().session({
      database: this.options.database,
    });
    try {
      return await operation(session);
    } finally {
      await session.close();
    }
  }

  async addEntity(entity: GraphEntity): Promise<void> {
    await this.withSession(async (session) => {
      // MERGE 幂等：已存在则把新 memoryId 并入数组（Cypher 端去重）
      await session.run(
        `MERGE (e:MemoryEntity {name: $name})
         ON CREATE SET e.type = $type, e.memoryIds = $memoryIds
         WITH e
         UNWIND $memoryIds AS mid
         WHERE NOT mid IN e.memoryIds
         SET e.memoryIds = coalesce(e.memoryIds, []) + mid`,
        {
          name: entity.name,
          type: entity.type,
          memoryIds: entity.memoryIds,
        },
      );
    });
  }

  async addRelation(relation: GraphRelation): Promise<void> {
    await this.withSession(async (session) => {
      // 先确保两端实体存在（兜底，正常流程 addEntity 已建过）
      await session.run(
        `MERGE (a:MemoryEntity {name: $source})
         MERGE (b:MemoryEntity {name: $target})
         CREATE (a)-[:MEMORY_RELATION {
           type: $type,
           memoryId: $memoryId
         }]->(b)`,
        {
          source: relation.sourceName,
          target: relation.targetName,
          type: relation.relation,
          memoryId: relation.memoryId ?? null,
        },
      );
    });
  }

  async getEntity(name: string): Promise<GraphEntity | undefined> {
    return this.withSession(async (session) => {
      const result = await session.run(
        "MATCH (e:MemoryEntity {name: $name}) RETURN e.name AS name, e.type AS type, e.memoryIds AS memoryIds",
        { name },
      );
      const record = result.records[0];
      if (!record) return undefined;
      return {
        name: record.get("name"),
        type: record.get("type") ?? "UNKNOWN",
        memoryIds: (record.get("memoryIds") ?? []) as string[],
      };
    });
  }

  async listEntities(limit?: number): Promise<GraphEntity[]> {
    return this.withSession(async (session) => {
      const result = await session.run(
        "MATCH (e:MemoryEntity) " +
          "RETURN e.name AS name, e.type AS type, e.memoryIds AS memoryIds " +
          "ORDER BY size(coalesce(e.memoryIds, [])) DESC " +
          (limit === undefined ? "" : "LIMIT $limit"),
        limit === undefined ? {} : { limit: neo4j.int(limit) },
      );
      return result.records.map((record) => ({
        name: record.get("name"),
        type: record.get("type") ?? "UNKNOWN",
        memoryIds: (record.get("memoryIds") ?? []) as string[],
      }));
    });
  }

  async getRelationsForEntities(
    names: string[],
    limit?: number,
  ): Promise<GraphRelation[]> {
    if (names.length === 0) return [];
    return this.withSession(async (session) => {
      const result = await session.run(
        `MATCH (a:MemoryEntity)-[r:MEMORY_RELATION]-(b:MemoryEntity)
         WHERE a.name IN $names
         RETURN a.name AS source, b.name AS target, r.type AS type, r.memoryId AS memoryId
         ${limit === undefined ? "" : "LIMIT $limit"}`,
        limit === undefined ? { names } : { names, limit: neo4j.int(limit) },
      );
      return result.records.map((record) => ({
        sourceName: record.get("source"),
        targetName: record.get("target"),
        relation: record.get("type") ?? "RELATED_TO",
        memoryId: record.get("memoryId") ?? undefined,
      }));
    });
  }

  async getMemoryIdsForEntities(names: string[]): Promise<string[]> {
    if (names.length === 0) return [];

    // 1) 命中实体自身的 memoryIds
    const ownIds = new Set<string>();
    const neighbors = new Set<string>();
    await this.withSession(async (session) => {
      const result = await session.run(
        `MATCH (e:MemoryEntity)-[r:MEMORY_RELATION]-(other:MemoryEntity)
         WHERE e.name IN $names
         RETURN e.memoryIds AS ownIds, other.memoryIds AS neighborIds, r.memoryId AS relationId`,
        { names },
      );
      for (const record of result.records) {
        for (const id of ((record.get("ownIds") ?? []) as string[])) ownIds.add(id);
        for (const id of ((record.get("neighborIds") ?? []) as string[])) neighbors.add(id);
        const relationId = record.get("relationId");
        if (typeof relationId === "string") neighbors.add(relationId);
      }
      // 没有关系的实体也要拿到 memoryIds
      const lonely = await session.run(
        "MATCH (e:MemoryEntity) WHERE e.name IN $names RETURN collect(e.memoryIds) AS idsList",
        { names },
      );
      const idsList = (lonely.records[0]?.get("idsList") ?? []) as string[][];
      for (const ids of idsList) for (const id of ids) ownIds.add(id);
    });

    return [...new Set([...ownIds, ...neighbors])];
  }

  async clear(): Promise<void> {
    await this.withSession(async (session) => {
      await session.run("MATCH (n) DETACH DELETE n");
    });
  }

  async close(): Promise<void> {
    await this.driver?.close();
    this.driver = undefined;
  }
}
