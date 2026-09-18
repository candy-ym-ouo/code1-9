/**
 * 解析单个 HTTP `Range: bytes=...` 请求头。
 *
 * 与媒体流相关的安全约束：
 * - 只支持单段范围（`bytes=a-b` / `bytes=a-` / `bytes=-suffix`），多段范围（逗号分隔）一律拒绝；
 * - 起点/终点必须是安全整数，起点不得越过文件末尾，否则调用方应返回 416；
 * - 返回的 end 永远夹紧到文件末尾，避免下游读取越界导致错位。
 */
export function parseByteRange(header: string, size: number): { start: number; end: number } | null {
  if (!header.startsWith('bytes=')) return null;
  const value = header.slice(6).trim();
  if (!value || value.includes(',')) return null;

  const match = /^(\d*)-(\d*)$/.exec(value);
  if (!match) return null;

  const [, startText, endText] = match;
  if (!startText && !endText) return null;

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    const start = Math.max(size - suffixLength, 0);
    return { start, end: size - 1 };
  }

  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }

  return { start, end: Math.min(requestedEnd, size - 1) };
}

/** 计算 [start, end] 闭区间在按 segmentSize 切块后覆盖的分片索引区间。 */
export function coveringSegments(
  start: number,
  end: number,
  segmentSize: number,
): { firstIndex: number; lastIndex: number } {
  return {
    firstIndex: Math.floor(start / segmentSize),
    lastIndex: Math.floor(end / segmentSize),
  };
}

/** 单个分片在文件中的字节区间；最后一片可能短于 segmentSize。 */
export function segmentBounds(
  index: number,
  segmentSize: number,
  size: number,
): { start: number; end: number } {
  const start = index * segmentSize;
  return { start, end: Math.min(start + segmentSize, size) - 1 };
}
