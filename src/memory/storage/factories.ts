/**
 * 存储默认装配工厂（对应书 8.1.4：Qdrant/Neo4j 配置存在即用专业数据库）
 *
 * 优先级：显式注入 > MemoryConfig > 环境变量 > 内存兜底。
 * 这样 MemoryManager / RAGTool 不传存储时自动读 .env：
 * 配了 QDRANT_URL/NEO4J_URI 就连真实数据库（数据在本地 Docker 或云端），
 * 什么都没配就退化成进程内实现——零配置也能跑通全部功能。
 */

import type { MemoryConfig } from "../base";
import { InMemoryDocumentStore } from "./document-store";
import { SQLiteDocumentStore } from "./document-store";
import type { DocumentStore } from "./document-store";
import { InMemoryGraphStore } from "./graph-store";
import type { GraphStore } from "./graph-store";
import { Neo4jGraphStore } from "./neo4j-store";
import { QdrantVectorStore } from "./qdrant-store";
import { InMemoryVectorStore } from "./vector-store";
import type { VectorStore } from "./vector-store";

export type StorageEnvSource = Record<string, string | undefined>;

export interface StorageFactoryOptions {
  config?: MemoryConfig;
  env?: StorageEnvSource;
  /** RAG 用独立集合名时传入 */
  collection?: string;
}

/** 向量库：QDRANT_URL 已配置 → Qdrant；否则进程内 */
export function createDefaultVectorStore(
  options: StorageFactoryOptions = {},
): VectorStore {
  const env = options.env ?? process.env;
  const url = options.config?.qdrantUrl ?? env.QDRANT_URL;
  if (!url) return new InMemoryVectorStore();
  return new QdrantVectorStore({
    url,
    apiKey: (options.config?.qdrantApiKey ?? env.QDRANT_API_KEY) || undefined,
    collection:
      options.collection ??
      options.config?.qdrantCollection ??
      env.QDRANT_COLLECTION ??
      "hello_agents_vectors",
  });
}

/** 图库：NEO4J_URI 已配置 → Neo4j；否则进程内 */
export function createDefaultGraphStore(
  options: StorageFactoryOptions = {},
): GraphStore {
  const env = options.env ?? process.env;
  const uri = options.config?.neo4jUri ?? env.NEO4J_URI;
  if (!uri) return new InMemoryGraphStore();
  return new Neo4jGraphStore({
    uri,
    username:
      options.config?.neo4jUsername ??
      env.NEO4J_USERNAME ??
      "neo4j",
    password: options.config?.neo4jPassword ?? env.NEO4J_PASSWORD ?? "",
    database: env.NEO4J_DATABASE ?? "neo4j",
  });
}

/** 文档库：SQLite 持久化（默认 ./memory_data/memory.db，对应书的行为） */
export function createDefaultDocumentStore(
  options: StorageFactoryOptions = {},
): DocumentStore {
  const env = options.env ?? process.env;
  const databasePath =
    options.config?.databasePath ??
    env.MEMORY_DATABASE_PATH ??
    "./memory_data/memory.db";
  return new SQLiteDocumentStore(databasePath);
}

/** 内存兜底全家桶（测试/演示用，零 IO） */
export function createInMemoryStores(): {
  vectorStore: VectorStore;
  graphStore: GraphStore;
  documentStore: DocumentStore;
} {
  return {
    vectorStore: new InMemoryVectorStore(),
    graphStore: new InMemoryGraphStore(),
    documentStore: new InMemoryDocumentStore(),
  };
}
