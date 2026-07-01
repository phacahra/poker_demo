/* =========================================================================
 *  gen-version.mjs — แปลง CHANGELOG.md → version.json อัตโนมัติ
 *
 *  วิธีใช้:  node gen-version.mjs
 *  ผลลัพธ์:  เขียนไฟล์ version.json (แหล่งข้อมูลที่ index.html ดึงไปแสดง)
 *
 *  รูปแบบ CHANGELOG.md ที่รองรับ:
 *    ## v1.5.0 — 2026-07-01 — หัวข้อสั้น
 *    - รายการอัปเดต 1
 *    - รายการอัปเดต 2
 *
 *  เวอร์ชันของ entry บนสุด = version ปัจจุบันของเว็บ
 * ========================================================================= */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const md = readFileSync(join(here, 'CHANGELOG.md'), 'utf8');

const changelog = [];
let current = null;
// รองรับตัวคั่นทั้ง em dash (—) และ hyphen (-) ระหว่างฟิลด์
const HEAD = /^##\s+v([0-9]+\.[0-9]+\.[0-9]+)\s*[—-]\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*[—-]\s*(.+?)\s*$/;

for (const raw of md.split(/\r?\n/)) {
  const line = raw.trimEnd();
  const h = line.match(HEAD);
  if (h) {
    current = { v: h[1], date: h[2], title: h[3].trim(), items: [] };
    changelog.push(current);
    continue;
  }
  const m = line.match(/^-\s+(.*\S)\s*$/);
  if (m && current) current.items.push(m[1].trim());
}

if (changelog.length === 0) {
  console.error('❌ ไม่พบ entry ใน CHANGELOG.md — ตรวจรูปแบบหัวข้อ "## vX.Y.Z — วันที่ — หัวข้อ"');
  process.exit(1);
}

const out = {
  version: changelog[0].v,
  generatedAt: new Date().toISOString(),
  changelog,
};
writeFileSync(join(here, 'version.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`✅ สร้าง version.json แล้ว — version=${out.version}, ทั้งหมด ${changelog.length} entries`);
