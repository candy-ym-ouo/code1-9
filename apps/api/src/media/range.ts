export type ByteRange = { start: number; end: number };

export function parseByteRange(header: string, size: number): ByteRange | null {
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

export function buildFileEtag(fileStat: { size: number; mtimeMs: number }): string {
  return `"${fileStat.size.toString(16)}-${Math.floor(fileStat.mtimeMs).toString(16)}"`;
}

// If-Range 匹配时才按 Range 返回 206，否则回退 200 全量，
// 避免客户端在文件版本变化后把新旧字节拼接错位。
export function shouldHonorRange(
  ifRangeHeader: string | undefined,
  etag: string,
  mtimeMs: number,
): boolean {
  if (!ifRangeHeader) return true;
  const value = ifRangeHeader.trim();
  if (!value) return true;

  if (value.startsWith('W/')) return false;
  if (value.startsWith('"')) return value === etag;

  const date = Date.parse(value);
  if (Number.isNaN(date)) return false;
  return Math.floor(mtimeMs / 1000) <= Math.floor(date / 1000);
}
