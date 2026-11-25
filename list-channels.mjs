#!/usr/bin/env node
/** 列出内置渠道。用法：node list-channels.mjs [关键词] */
import { CHANNELS } from './channels.js';

const q = (process.argv[2] || '').toLowerCase();
const rows = CHANNELS.filter(
  (c) => !q || c.id.includes(q) || c.name.toLowerCase().includes(q) || (c.baseURL || '').toLowerCase().includes(q),
);

const pad = (s, n) => String(s ?? '').padEnd(n);
console.log(pad('channel id', 14) + pad('名称', 20) + pad('baseURL', 48) + 'key 环境变量');
console.log('-'.repeat(110));
for (const c of rows) {
  const flag = c.verified ? ' ' : ' *';
  console.log(
    pad(c.id, 14) + pad(c.name, 20) + pad((c.baseURL || '(需自填)') + flag, 48) + (c.apiKeyEnv || '-'),
  );
}
console.log('\n* = 公开端点但本机未验证，用前请确认。其余为实测或官方文档确认。');
if (rows.some((c) => c.note)) {
  console.log('\n备注：');
  for (const c of rows.filter((x) => x.note)) console.log(`  ${c.id}: ${c.note}`);
}
