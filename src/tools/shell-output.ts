/**
 * shell 输出解码（修复中文 Windows 的 cmd.exe GBK 乱码）
 *
 * 现象：中文系统 cmd.exe 输出 GBK 编码，child_process 默认按 UTF-8
 * 解码必得替换符乱码（如 `dir` 的"卷 C 中的卷是"）。
 *
 * 策略（业界通用启发式）：严格 UTF-8 优先——ASCII 与真 UTF-8 原样通过；
 * 解码失败（GBK 字节序列对 UTF-8 非法）降级 GBK（Node 全 ICU 内置
 * TextDecoder 支持）；再失败按 UTF-8 宽松兜底。
 */

export function decodeShellOutput(output: Buffer | string): string {
  if (typeof output === "string") return output;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    try {
      return new TextDecoder("gbk").decode(output);
    } catch {
      return output.toString("utf8");
    }
  }
}
