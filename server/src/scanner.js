import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PROJECTS_DIR, decodeProjectDir } from './config.js';
import { parseChunk } from './parser.js';

/**
 * 增量扫描器。
 *
 * JSONL 是追加写的：文件变大 = 有新内容，可以只读尾巴。
 * 每个文件维护 { size, offset, records, meta }：
 *   - 文件变小 → 判定被重写，整体重解析
 *   - 文件变大 → 从 offset 续读
 *   - 只处理到最后一个 '\n'，避免把写了一半的行解析掉
 *
 * 同时用 (mtimeMs, size) 做快速指纹，未变化的文件直接跳过。
 */
export class Scanner {
  constructor({ fileCacheDir = null } = {}) {
    /** @type {Map<string, {size:number, offset:number, mtimeMs:number, records:any[], meta:object}>} */
    this.files = new Map();
    this.fileCacheDir = fileCacheDir;
  }

  /** 递归找出所有会话 JSONL */
  async discover() {
    const out = [];
    let projects = [];
    try {
      projects = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
    } catch {
      return out;
    }

    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const dir = path.join(PROJECTS_DIR, p.name);
      let files = [];
      try {
        files = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue; // 跳过 .file-rollback.ndjson 等
        out.push({
          filePath: path.join(dir, f),
          projectId: p.name,
          sessionId: f.replace(/\.jsonl$/, ''),
        });
      }
    }
    return out;
  }

  /** 扫描全部文件，返回是否发生了变化 */
  async scan() {
    const files = await this.discover();
    const seen = new Set();
    let changed = false;

    for (const info of files) {
      seen.add(info.filePath);
      if (await this.#syncFile(info)) changed = true;
    }

    // 清理已删除的文件
    for (const key of [...this.files.keys()]) {
      if (!seen.has(key)) {
        this.files.delete(key);
        changed = true;
      }
    }

    if (changed) await this.#persist();
    return changed;
  }

  async #syncFile({ filePath, projectId, sessionId }) {
    let st;
    try {
      st = await fsp.stat(filePath);
    } catch {
      return false;
    }
    if (!st.isFile()) return false;

    const prev = this.files.get(filePath);

    // 未变化 → 跳过
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return false;

    // 首次出现 / 被重写 → 全量解析
    if (!prev || st.size < prev.offset) {
      const text = await fsp.readFile(filePath, 'utf8');
      const cut = text.lastIndexOf('\n');
      const usable = cut >= 0 ? text.slice(0, cut + 1) : '';
      const { records, meta, events } = parseChunk(usable, { projectId, sessionId });
      this.files.set(filePath, {
        size: st.size,
        offset: Buffer.byteLength(usable, 'utf8'),
        mtimeMs: st.mtimeMs,
        records,
        events,
        meta,
        projectId,
        sessionId,
        filePath,
      });
      return true;
    }

    // 追加 → 读尾巴
    const start = prev.offset;
    const handle = await fsp.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      await handle.read(buf, 0, buf.length, start);
      const chunk = buf.toString('utf8');
      const cut = chunk.lastIndexOf('\n');
      if (cut < 0) {
        // 还只有半行，等下次
        prev.size = st.size;
        prev.mtimeMs = st.mtimeMs;
        return false;
      }
      const usable = chunk.slice(0, cut + 1);
      const { records, meta, events } = parseChunk(usable, { projectId, sessionId });
      prev.records.push(...records);
      prev.events.push(...events);
      Object.assign(prev.meta, meta);
      prev.offset = start + Buffer.byteLength(usable, 'utf8');
      prev.size = st.size;
      prev.mtimeMs = st.mtimeMs;
      return true;
    } finally {
      await handle.close();
    }
  }

  /** 汇总所有文件的记录 */
  all() {
    const records = [];
    const sessions = [];
    /**
     * 每个会话一条有序事件时间线。
     * 耗时只能靠"相邻事件时间差"还原，而这个差值**跨解析块**——
     * 某次请求的起点可能落在上一次增量读进来的那段里。
     * 所以配对必须在攒齐事件之后做，不能放在 parseChunk 里。
     */
    const timelines = [];

    for (const f of this.files.values()) {
      records.push(...f.records);
      const events = f.events || [];
      // 没有任何用量记录、也没有事件的会话才跳过。
      // 只按 records 判会把"只有工具调用、没有用量行"的会话整条丢掉，
      // 连带它的工具耗时一起从时间去向里消失。
      if (f.records.length === 0 && events.length === 0) continue;
      sessions.push({
        sessionId: f.sessionId,
        projectId: f.projectId,
        title: f.meta.title || '',
        cwd: f.meta.cwd || '',
        cwdPretty: f.meta.cwd || decodeProjectDir(f.projectId),
        filePath: f.filePath,
      });
      timelines.push({
        sessionId: f.sessionId,
        projectId: f.projectId,
        events,
      });
    }

    // 会话元信息回填到记录上（标题只有 ai-title 行才知道）
    const bySession = new Map(sessions.map((s) => [s.sessionId, s]));
    for (const r of records) {
      const s = bySession.get(r.sessionId);
      if (!s) continue;
      r.title = s.title;
      if (!r.cwd) r.cwd = s.cwd;
    }

    return { records, sessions, timelines };
  }

  /** 落一份轻量快照，方便排查解析问题 */
  async #persist() {
    if (!this.fileCacheDir) return;
    try {
      await fsp.mkdir(this.fileCacheDir, { recursive: true });
      const snapshot = [...this.files.values()].map((f) => ({
        filePath: f.filePath,
        size: f.size,
        offset: f.offset,
        count: f.records.length,
      }));
      await fsp.writeFile(
        path.join(this.fileCacheDir, 'scan-state.json'),
        JSON.stringify(snapshot, null, 2),
      );
    } catch {
      /* 快照失败不影响主流程 */
    }
  }
}

export { fs };
