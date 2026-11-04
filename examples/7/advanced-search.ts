/** 多源搜索工具示例（对应书 7.5.3 test_advanced_search.py；未配 Key 时打印配置指引） */
import "dotenv/config";
import { createAdvancedSearchRegistry } from "../../src/index";

const registry = createAdvancedSearchRegistry();
console.log(`工具描述:\n${registry.getToolsDescription()}\n`);

const result = await registry.executeTool("advanced_search", "TypeScript 的发展历史");
console.log(`搜索结果:\n${result}`);
