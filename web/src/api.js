/** 后端 API 封装 */
const BASE = '/api';

function qs(params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '' || v === 'all') continue;
    sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function get(path, params) {
  const res = await fetch(BASE + path + qs(params));
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `请求失败 ${res.status}`);
  }
  return res.json();
}

export const api = {
  meta: () => get('/meta'),
  overview: (f) => get('/overview', f),
  sessions: (f) => get('/sessions', f),
  session: (f) => get('/session', f),
  requests: (f) => get('/requests', f),
  refresh: async () => {
    const res = await fetch(BASE + '/refresh', { method: 'POST' });
    return res.json();
  },
};

/** 把筛选状态转成查询参数 */
export function toParams(filter) {
  const p = {
    from: filter.from || undefined,
    to: filter.to || undefined,
    projectId: filter.projectId,
    model: filter.model,
    kind: filter.kind,
    keyword: filter.keyword,
    granularity: filter.granularity,
  };
  return p;
}
