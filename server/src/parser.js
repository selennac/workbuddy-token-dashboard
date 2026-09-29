/**
 * 单行 JSONL → 规范化用量记录。
 *
 * 关键事实（已对真实数据验证）：
 * 1. token 用量只挂在 providerData.rawUsage 上，出现在 type 为
 *    function_call / message 的行（即每一次真实的大模型请求）。
 * 2. providerData.messageId 在全部样本中全局唯一（404/404），
 *    是天然的"一次请求"主键；traceId 是"一轮对话"（内含多次请求），
 *    不能用来计数。
 * 3. rawUsage 是单次请求的增量值，不是累计值。
 * 4. rawUsage.credit 是平台算好的结算单位，无需自建价格表。
 */

const num = (v) => (Number.isFinite(v) ? v : 0);

/** 从一行的 providerData 中提取用量，没有则返回 null */
export function extractUsage(line) {
  const pd = line.providerData;
  if (!pd) return null;

  // 优先 rawUsage（字段最全），退化为 usage / message.usage
  const ru = pd.rawUsage;
  const fallback = pd.usage || {};
  const msgUsage = (line.message && line.message.usage) || {};

  const prompt = num(ru ? ru.prompt_tokens : fallback.inputTokens ?? msgUsage.input_tokens);
  const completion = num(ru ? ru.completion_tokens : fallback.outputTokens ?? msgUsage.output_tokens);
  const total = num(ru ? ru.total_tokens : fallback.totalTokens ?? msgUsage.total_tokens);

  if (total === 0 && prompt === 0 && completion === 0) return null;

  const cacheRead = num(
    ru
      ? ru.prompt_cache_hit_tokens ?? (ru.prompt_tokens_details || {}).cached_tokens
      : msgUsage.cache_read_input_tokens,
  );
  const cacheMiss = num(ru ? ru.prompt_cache_miss_tokens : prompt - cacheRead);
  const reasoning = num(
    ru ? ru.completion_thinking_tokens ?? (ru.completion_tokens_details || {}).reasoning_tokens : 0,
  );

  return {
    id: pd.messageId || line.messageId || line.id,
    prompt,
    completion,
    total: total || prompt + completion,
    cacheRead,
    cacheMiss,
    reasoning,
    credit: num(ru && ru.credit),
  };
}

/**
 * 把一行压成时间线上的一个"显著事件"。
 *
 * 为什么只留这三类：耗时不在任何字段里，只能靠**相邻事件的 timestamp 差**还原。
 * 而真正划分时间段的只有三种边界——
 *   - msg/user  用户发消息（上一段是"用户在想/离开"）
 *   - fc        模型带着用量完成一次响应（上一段是"模型生成"）
 *   - fcr       工具返回（上一段是"工具执行"）
 * reasoning / file-history-snapshot / session-meta 都夹在中间且时间戳几乎重合，
 * 留着只会把 127 秒的生成时间错记到某个 18 毫秒的碎行头上，所以直接丢掉。
 *
 * @param {object} o 一行 JSON
 * @returns {{t:number, ty:string, mid?:string, cid?:string, nm?:string, role?:string, u?:number}|null}
 */
function toEvent(o) {
  const t = o.timestamp;
  if (!Number.isFinite(t)) return null;
  const pd = o.providerData || {};

  // function_call 有两种：带用量的那条 = 本次请求的完成点；其余是同一响应的并行工具调用
  if (o.type === 'function_call') {
    return { t, ty: 'fc', mid: pd.messageId || '', cid: o.callId || '', nm: o.name || '', u: pd.rawUsage ? 1 : 0 };
  }
  if (o.type === 'function_call_result') {
    return { t, ty: 'fcr', cid: o.callId || '', nm: o.name || '' };
  }
  if (o.type === 'message') {
    return { t, ty: 'msg', role: o.role || '', mid: pd.messageId || '', u: pd.rawUsage ? 1 : 0 };
  }
  return null;
}

/**
 * 解析一份 JSONL 文本块，返回 { records, meta, events }。
 * @param {string} text 文本内容（必须是完整的行，末尾可以没有换行）
 * @param {object} ctx  { projectId, sessionId, cwd }
 */
export function parseChunk(text, ctx) {
  const records = [];
  const meta = {};
  /** 时间线事件，保持文件内的原始顺序（追加写 ⇒ 顺序即真实顺序） */
  const events = [];
  const lines = text.split('\n');

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // 容忍截断/脏行
    }

    // 会话元信息
    if (o.type === 'ai-title' && o.aiTitle) meta.title = o.aiTitle;
    if (o.cwd) meta.cwd = o.cwd;
    if (o.sessionId) meta.sessionId = o.sessionId;

    const ev = toEvent(o);
    if (ev) events.push(ev);

    const usage = extractUsage(o);
    if (!usage) continue;

    records.push({
      id: usage.id,
      sessionId: o.sessionId || ctx.sessionId,
      projectId: ctx.projectId,
      cwd: o.cwd || ctx.cwd || '',
      ts: num(o.timestamp),
      kind: o.type || 'unknown', // function_call / message
      toolName: o.name || null,
      model: (o.providerData && o.providerData.model) || 'unknown',
      modelName: (o.providerData && o.providerData.requestModelName) || '',
      traceId: (o.providerData && o.providerData.traceId) || '',
      requestId: (o.providerData && o.providerData.conversationRequestId) || '',
      ...usage,
    });
  }

  return { records, meta, events };
}
