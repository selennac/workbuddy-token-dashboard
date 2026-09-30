import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 定位 WorkBuddy 数据目录。
 * 优先级：环境变量 WORKBUDDY_HOME > ~/.workbuddy
 * 校验条件：目录下存在 projects/ 子目录
 */
function resolveHome() {
  const candidates = [
    process.env.WORKBUDDY_HOME,
    path.join(os.homedir(), '.workbuddy'),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      if (fs.statSync(path.join(dir, 'projects')).isDirectory()) return dir;
    } catch {
      /* 忽略，尝试下一个 */
    }
  }
  // 兜底返回默认路径，让上层报错更直观
  return path.join(os.homedir(), '.workbuddy');
}

export const HOME = resolveHome();
export const PROJECTS_DIR = path.join(HOME, 'projects');

export const PORT = Number(process.env.PORT || 5178);

/**
 * 后台自动增量扫描间隔。
 * JSONL 是追加写的，扫描只读新增尾巴、未变化的文件直接跳过，所以 5s 一次成本很低。
 * 想调松/调紧用 SCAN_INTERVAL_MS 环境变量，不用改代码。
 */
export const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 5_000);

/** 前端开发服务器地址，用于 CORS */
export const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

/**
 * 项目目录名还原为可读路径。
 * WorkBuddy 把 cwd 编码成 d-CODE-MyApp 这种形式。
 * 注意：cwd 字段本身有真值时优先用真值，这里只是兜底展示。
 */
export function decodeProjectDir(dirName) {
  const m = /^([a-zA-Z])-(.*)$/.exec(dirName);
  if (!m) return dirName;
  return `${m[1].toLowerCase()}:\\${m[2].replace(/-/g, '\\')}`;
}

/** 结算计价单位名称，WorkBuddy 用量里叫 credit */
export const CREDIT_UNIT = 'credit';
