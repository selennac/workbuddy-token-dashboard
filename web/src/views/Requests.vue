<script setup>
import { computed, ref, watch } from 'vue';
import { api, toParams } from '../api.js';
import { fmtNum, fmtCredit, fmtPct, fmtTime, fmtSec, fmtSpeed } from '../utils/format.js';
import AppSelect from '../components/ui/AppSelect.vue';

const props = defineProps({ filter: Object });
const emit = defineEmits(['open-session']);

const page = ref(1);
const size = ref(50);
const data = ref({ items: [], total: 0 });
const error = ref('');
const expanded = ref(new Set());

const SIZE_OPTIONS = [
  { value: 50, label: '50 / 页' },
  { value: 100, label: '100 / 页' },
  { value: 200, label: '200 / 页' },
];

async function load() {
  error.value = '';
  try {
    data.value = await api.requests({ ...toParams(props.filter), page: page.value, size: size.value });
  } catch (e) {
    error.value = e.message;
  }
}

watch(() => props.filter, () => { page.value = 1; load(); }, { deep: true, immediate: true });
watch([page, size], load);
defineExpose({ reload: load });

const totalPages = computed(() => Math.max(1, Math.ceil(data.value.total / size.value)));

function toggle(id) {
  const s = new Set(expanded.value);
  s.has(id) ? s.delete(id) : s.add(id);
  expanded.value = s;
}
</script>

<template>
  <div class="panel view-fill">
    <div class="panel-head">
      <div>
        <div class="panel-title">请求明细</div>
        <div class="panel-sub">
          每一次大模型请求一行，按 messageId 去重 · 共 {{ fmtNum(data.total) }} 条 ·
          「耗时」为上一次工具返回到本次响应完成的端到端时间
        </div>
      </div>
      <div class="pager">
        <AppSelect
          :model-value="size"
          :options="SIZE_OPTIONS"
          align="right"
          @update:model-value="size = Number($event)"
        />
        <button class="btn" :disabled="page <= 1" @click="page--">上一页</button>
        <span class="num muted" style="font-size: 12px">{{ page }} / {{ totalPages }}</span>
        <button class="btn" :disabled="page >= totalPages" @click="page++">下一页</button>
      </div>
    </div>

    <div v-if="error" class="empty">{{ error }}</div>

    <div v-else class="scroll">
      <table>
        <thead>
          <tr>
            <th style="width: 26px" />
            <th>时间</th>
            <th>会话</th>
            <th>模型</th>
            <th>类型</th>
            <th>工具</th>
            <th class="right">输入</th>
            <th class="right">命中率</th>
            <th class="right">输出</th>
            <th class="right">思考</th>
            <th class="right">合计</th>
            <th class="right">耗时</th>
            <th class="right">吐字速度</th>
            <th class="right">credit</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="r in data.items" :key="r.id">
            <tr style="cursor: pointer" @click="toggle(r.id)">
              <td class="muted" style="text-align: center">{{ expanded.has(r.id) ? '▾' : '▸' }}</td>
              <td class="num">{{ fmtTime(r.ts) }}</td>
              <td class="cell-title" :title="r.title">{{ r.title || r.sessionId.slice(0, 8) }}</td>
              <td class="mono">{{ r.model }}</td>
              <td><span class="tag gray">{{ r.kind }}</span></td>
              <td>
                <span v-if="r.toolName" class="tag">{{ r.toolName }}</span>
                <span v-else class="muted">—</span>
              </td>
              <td class="right num">{{ fmtNum(r.prompt) }}</td>
              <td class="right num" :style="{ color: r.prompt && r.cacheRead / r.prompt > 0.9 ? '#12885a' : undefined }">
                {{ fmtPct(r.prompt ? r.cacheRead / r.prompt : 0, 0) }}
              </td>
              <td class="right num">{{ fmtNum(r.completion) }}</td>
              <td class="right num muted">{{ fmtNum(r.reasoning) }}</td>
              <td class="right num">{{ fmtNum(r.total) }}</td>
              <td class="right num" :title="`含每请求固定开销 ${fmtSec(r.overheadMs)}`">{{ fmtSec(r.durMs) }}</td>
              <td class="right num">
                <span
                  v-if="r.tps == null"
                  class="muted"
                  title="净出字时长不足（本次耗时几乎等于每请求固定开销），算不出可信的瞬时速度"
                >—</span>
                <span
                  v-else
                  title="瞬时速度，用「耗时 − 该模型每请求固定开销」当分母。净出字时长里仍含处理输入的时间，所以未命中缓存输入很大的请求读数会偏低；看模型的平均速度请用总览的模型明细"
                >{{ fmtSpeed(r.tps) }} <span class="unit">t/s</span></span>
              </td>
              <td class="right num"><b>{{ fmtCredit(r.credit) }}</b></td>
            </tr>
            <tr v-if="expanded.has(r.id)" class="detail-row">
              <td />
              <td colspan="13">
                <div class="detail">
                  <div><span class="k">messageId</span><span class="mono v">{{ r.id }}</span></div>
                  <div><span class="k">sessionId</span><span class="mono v">{{ r.sessionId }}</span></div>
                  <div><span class="k">projectId</span><span class="mono v">{{ r.projectId }}</span></div>
                  <div><span class="k">缓存命中 token</span><span class="mono v">{{ fmtNum(r.cacheRead) }}</span></div>
                  <div><span class="k">缓存未命中</span><span class="mono v">{{ fmtNum(r.prompt - r.cacheRead) }}</span></div>
                  <div><span class="k">思考 token</span><span class="mono v">{{ fmtNum(r.reasoning) }}</span></div>
                  <div>
                    <span class="k">端到端耗时</span>
                    <span class="mono v">{{ fmtSec(r.durMs) }}</span>
                  </div>
                  <div>
                    <span class="k">固定开销</span>
                    <span class="mono v">{{ fmtSec(r.overheadMs) }}</span>
                  </div>
                  <div>
                    <span class="k">净出字时长</span>
                    <span class="mono v">{{ fmtSec(r.netMs) }}</span>
                  </div>
                  <div>
                    <span class="k">吐字速度</span>
                    <span class="mono v">{{ r.tps == null ? '不可用' : fmtSpeed(r.tps) + ' t/s' }}</span>
                  </div>
                  <button class="btn" style="margin-left: auto" @click.stop="emit('open-session', r.sessionId)">
                    查看所属会话 →
                  </button>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="!data.items.length">
            <td colspan="14" class="empty">当前筛选条件下没有记录</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.pager {
  display: flex;
  gap: 8px;
  align-items: center;
}
.cell-title {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.detail-row td {
  background: rgba(255, 255, 255, 0.5);
  padding: 0;
}
.detail {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 28px;
  padding: 13px 16px;
  align-items: center;
  border-left: 2px solid var(--accent-line);
}
.detail > div {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.k {
  color: var(--text-3);
  font-size: 11px;
}
.v {
  color: var(--text);
}
.unit {
  font-size: 10px;
  color: var(--text-3);
}
</style>
