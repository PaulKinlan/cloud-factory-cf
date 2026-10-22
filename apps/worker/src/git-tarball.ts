import { MAX_TREE_BYTES, MAX_TREE_FILES, type TreeFile } from "./git-tree-store";

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function field(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

/** Parse a small raw ustar archive without executing code, links, or device entries. */
export function tarballFiles(bytes: Uint8Array): TreeFile[] {
  if (bytes.length > MAX_TREE_BYTES) throw new Error("tarball exceeds size limit");
  const files: TreeFile[] = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const storedChecksum = Number.parseInt(field(header.subarray(148, 156)).trim(), 8);
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (!Number.isSafeInteger(storedChecksum) || checksum !== storedChecksum) throw new Error("invalid tar checksum");
    const sizeField = field(header.subarray(124, 136)).trim();
    if (!/^[0-7]+$/.test(sizeField)) throw new Error("invalid tar size");
    const size = Number.parseInt(sizeField, 8);
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(size) || next > bytes.length) throw new Error("truncated tarball");
    const type = header[156];
    if (type === 0 || type === 48) {
      const name = field(header.subarray(0, 100));
      const prefix = field(header.subarray(345, 500));
      const path = prefix ? `${prefix}/${name}` : name;
      const contentBytes = bytes.subarray(offset + 512, offset + 512 + size);
      let content: string | undefined;
      try {
        const text = decoder.decode(contentBytes);
        if (!text.includes("\0") && encoder.encode(text).length === size) content = text;
      } catch { /* Binary blobs retain their path and byte size, never corrupted text. */ }
      files.push(content === undefined ? { path, size } : { path, size, content });
      if (files.length > MAX_TREE_FILES) throw new Error("too many tarball files");
    } else if (type !== 53) {
      // Reject links, devices and tar extensions rather than risk unsafe paths or hidden data.
      throw new Error("unsupported tar entry type");
    }
    offset = next;
  }
  if (offset === 0) throw new Error("invalid tarball");
  return files;
}
