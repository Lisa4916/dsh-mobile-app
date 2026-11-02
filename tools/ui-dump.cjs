// 一次性：把 uiautomator dump 的节点打印成「文本 / 类 / bounds / 中心点」
const fs = require('fs');
const file = process.argv[2];
const xml = fs.readFileSync(file, 'utf8');
const re = /<node[^>]*>/g;
let m;
const rows = [];
while ((m = re.exec(xml))) {
  const tag = m[0];
  const get = (k) => {
    const r = new RegExp(k + '="([^"]*)"').exec(tag);
    return r ? r[1] : '';
  };
  const text = get('text') || get('content-desc');
  const bounds = get('bounds');
  if (!text.trim()) continue;
  const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(bounds);
  if (!b) continue;
  const cx = Math.round((+b[1] + +b[3]) / 2);
  const cy = Math.round((+b[2] + +b[4]) / 2);
  rows.push({ text: text.trim(), cls: get('class').split('.').pop(), bounds, cx, cy });
}
for (const r of rows) {
  console.log(String(JSON.stringify(r.text)).padEnd(46), r.cls.padEnd(18), r.bounds.padEnd(26), 'center=' + r.cx + ',' + r.cy);
}
console.log('--- 共 ' + rows.length + ' 个可见文本节点 ---');
