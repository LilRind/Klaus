/**
 * S18 类型化 KV 注册表（来源：dsh-superagent src/kv.ts 移植）。
 *
 * 每个键只拼写一次、带值类型、按唯一拥有者分组声明；读者与写者都通过
 * KV 对象引用键，消灭"键名拼错/无人知道谁在写"。值一律 JSON 序列化。
 */

/** 某个 KV 记录的键，携带值类型 V（品牌类型，仅编译期）。 */
export type Key<V> = string & { readonly __kvValue?: V };

/** 共享前缀的键族：由名字构造键，prefix 用于列举。 */
export type Family<V> = ((name: string) => Key<V>) & { readonly prefix: string };

export const kvRecord = <V>(key: string): Key<V> => key as Key<V>;

export const kvFamily = <V>(prefix: string): Family<V> =>
  Object.assign((name: string) => `${prefix}${name}` as Key<V>, { prefix });

/** 全部 KV 键的唯一登记处：按拥有者分组，注释说明值含义。 */
export const KV = {
  /** Store：库结构版本（迁移用）。 */
  store: { schema: kvRecord<number>("schema") },
  /** Engine：id 序列（跨重启单调，供 newId 兜底）。 */
  engine: { seq: kvRecord<number>("id-seq") },
} as const;
