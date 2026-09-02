// 這支腳本只在 GitHub Actions 的伺服器上執行（node scripts/build-data.mjs），
// 不會在使用者瀏覽器裡跑，所以完全不受瀏覽器 CORS / 使用者網路 DNS 限制影響。
// 執行結果會寫成 data/games.json，網頁只需要讀這個同源的靜態檔案。

import fs from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import he from 'he';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------
// 分類自動判斷規則（跟前端說明頁一致）
// ---------------------------------------------------------------
const CATEGORY_KEYS = ['派對遊戲', '陣營遊戲', '策略遊戲', '心機遊戲', '卡牌遊戲', '兒童遊戲', '家庭遊戲'];

const AUTO_RULES = [
  { key: '派對遊戲', test: (c, m, r, w) => c.has('Party Game') },
  { key: '陣營遊戲', test: (c, m, r, w) => m.has('Hidden Roles') || m.has('Traitor Game') || m.has('Voting') },
  { key: '心機遊戲', test: (c, m, r, w) => c.has('Bluffing') || c.has('Deduction') || c.has('Negotiation') || c.has('Spies/Secret Agents') },
  { key: '兒童遊戲', test: (c, m, r, w) => c.has("Children's Game") },
  { key: '卡牌遊戲', test: (c, m, r, w) => c.has('Card Game') },
  { key: '家庭遊戲', test: (c, m, r, w) => c.has('Family Game') || (r.familygames != null && r.familygames < 9999) },
  { key: '策略遊戲', test: (c, m, r, w) => (r.strategygames != null && r.strategygames < 9999) || w >= 2.6 },
];

function autoCategorize(catSet, mechSet, rankObj, weight) {
  for (const rule of AUTO_RULES) {
    if (rule.test(catSet, mechSet, rankObj, weight)) return rule.key;
  }
  return null;
}

// ---------------------------------------------------------------
// 簡易但穩健的 CSV 解析（支援雙引號、逗號、換行）
// ---------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/\r\n/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length && !(r.length === 1 && r[0] === ''));
}

function toNum(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}
function parseNums(str) {
  const nums = (str || '').match(/\d+/g);
  if (!nums) return null;
  const a = parseInt(nums[0], 10);
  const b = parseInt(nums[nums.length - 1], 10);
  return [a, isNaN(b) ? a : b];
}
function fmtRange(min, max, unit) {
  if (!min && !max) return '';
  if (!max || min === max) return `${min}${unit}`;
  return `${min}~${max}${unit}`;
}
function ownedSet(field) {
  if (!field) return new Set();
  return new Set(field.split(/[、,，;；]/).map((s) => s.trim().toLowerCase()).filter(Boolean));
}
function isOwned(exp, owned) {
  if (!owned.size) return false;
  if (owned.has(String(exp.id))) return true;
  const n = (exp.name || '').toLowerCase();
  for (const o of owned) if (o && n.includes(o)) return true;
  return false;
}
function checkImgur(url) {
  return url && /^https?:\/\/.+/i.test(url) ? url : '';
}
function decodeDescription(raw) {
  if (!raw) return '';
  let text = String(raw);
  text = he.decode(he.decode(text));
  text = text.replace(/<br\s*\/?>/gi, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}
function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------
// 1. 讀取設定 + 抓 Google Sheet CSV
// ---------------------------------------------------------------
const config = JSON.parse(await fs.readFile(new URL('../config.json', import.meta.url), 'utf-8'));
if (!config.csvUrl) throw new Error('config.json 缺少 csvUrl');

console.log('讀取 Google Sheet CSV:', config.csvUrl);
const csvRes = await fetch(config.csvUrl);
if (!csvRes.ok) throw new Error('CSV 下載失敗: HTTP ' + csvRes.status);
const csvText = await csvRes.text();
const rows = parseCsv(csvText);
if (!rows.length) throw new Error('CSV 內容是空的');

const headers = rows[0].map((h) => (h || '').trim().toUpperCase());
const records = [];
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  if (!r.some((c) => c && c.trim())) continue;
  const rec = {};
  headers.forEach((h, idx) => { rec[h] = (r[idx] || '').trim(); });
  if (!rec.NAME && !rec.BGGID) continue;
  records.push(rec);
}
console.log(`解析到 ${records.length} 筆遊戲資料`);

// ---------------------------------------------------------------
// 2. 向 BGG XML API2 批次查詢（每批最多 20 筆，官方建議請求間隔 5 秒）
// ---------------------------------------------------------------
const ids = [...new Set(records.map((r) => r.BGGID).filter(Boolean))];
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
const bggData = {};

for (let i = 0; i < ids.length; i += 20) {
  const chunk = ids.slice(i, i + 20);
  const url = `https://boardgamegeek.com/xmlapi2/thing?id=${chunk.join(',')}&stats=1`;
  console.log(`查詢 BGG (${i + 1}~${i + chunk.length}/${ids.length})...`);
  let xml = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url);
      xml = await res.text();
      if (xml.includes('<item')) break;
    } catch (e) {
      console.warn('查詢失敗，稍後重試:', e.message);
    }
    await sleep(3000);
  }
  if (xml.includes('<item')) {
    const doc = xmlParser.parse(xml);
    const items = asArray(doc.items?.item);
    for (const item of items) {
      bggData[String(item.id)] = extractItem(item);
    }
  } else {
    console.warn(`這批 id 查不到資料: ${chunk.join(',')}`);
  }
  if (i + 20 < ids.length) await sleep(5000); // 官方文件建議的請求間隔
}

function extractItem(item) {
  const names = asArray(item.name);
  const primary = names.find((n) => n.type === 'primary') || names[0] || {};
  const links = asArray(item.link);
  const publishers = links.filter((l) => l.type === 'boardgamepublisher').map((l) => l.value);
  const categories = new Set(links.filter((l) => l.type === 'boardgamecategory').map((l) => l.value));
  const mechanics = new Set(links.filter((l) => l.type === 'boardgamemechanic').map((l) => l.value));
  const expansions = links
    .filter((l) => l.type === 'boardgameexpansion' && l.inbound !== 'true')
    .map((l) => ({ id: String(l.id), name: l.value }));

  const ranksRaw = item.statistics?.ratings?.ranks?.rank;
  const rankObj = {};
  for (const r of asArray(ranksRaw)) {
    rankObj[r.name] = r.value === 'Not Ranked' || !r.value ? null : parseInt(r.value, 10);
  }
  const weight = item.statistics?.ratings?.averageweight?.value
    ? parseFloat(item.statistics.ratings.averageweight.value)
    : 0;

  return {
    name: primary.value || '',
    image: item.image || item.thumbnail || '',
    minplayers: item.minplayers?.value,
    maxplayers: item.maxplayers?.value,
    minplaytime: item.minplaytime?.value,
    maxplaytime: item.maxplaytime?.value,
    minage: item.minage?.value,
    publishers,
    categories,
    mechanics,
    expansions,
    rankObj,
    weight,
    description: decodeDescription(item.description),
  };
}

// ---------------------------------------------------------------
// 3. 合併 Sheet 手動欄位 + BGG 自動資料
// ---------------------------------------------------------------
function buildGame(rec) {
  const bgg = rec.BGGID ? bggData[rec.BGGID] : null;
  const player = rec.PLAYER || (bgg ? fmtRange(bgg.minplayers, bgg.maxplayers, '人') : '');
  const age = rec.AGE || (bgg && bgg.minage && bgg.minage !== '0' ? `${bgg.minage}+` : '');
  const time = rec.PLAYTIME || (bgg ? fmtRange(bgg.minplaytime, bgg.maxplaytime, '分') : '');
  const publisher = rec.PUBLISHER || (bgg && bgg.publishers.length ? bgg.publishers[0] : '');
  let category = rec.GAMETYPE && CATEGORY_KEYS.includes(rec.GAMETYPE) ? rec.GAMETYPE : null;
  if (!category && bgg) category = autoCategorize(bgg.categories, bgg.mechanics, bgg.rankObj, bgg.weight);
  const image = checkImgur(rec.IMGUR) || (bgg ? bgg.image : '');
  const name = rec.NAME || (bgg ? bgg.name : `#${rec.BGGID}`);
  const owned = ownedSet(rec.OWN);
  const expansions = bgg ? bgg.expansions.map((e) => ({ ...e, owned: isOwned(e, owned) })) : [];

  const playerRange = rec.PLAYER
    ? parseNums(rec.PLAYER)
    : bgg
      ? [toNum(bgg.minplayers), toNum(bgg.maxplayers) || toNum(bgg.minplayers)]
      : null;
  const timeRange = rec.PLAYTIME
    ? parseNums(rec.PLAYTIME)
    : bgg
      ? [toNum(bgg.minplaytime), toNum(bgg.maxplaytime) || toNum(bgg.minplaytime)]
      : null;

  return {
    bggid: rec.BGGID || '',
    name, player, age, time, publisher, category, image,
    description: (bgg && bgg.description) || '',
    note: rec.NOTE || '',
    expansions, playerRange, timeRange,
  };
}

const games = records.map(buildGame);
const missing = ids.filter((id) => !bggData[id]);

const output = {
  updatedAt: new Date().toISOString(),
  count: games.length,
  missingBggIds: missing,
  games,
};

await fs.mkdir(new URL('../data/', import.meta.url), { recursive: true });
await fs.writeFile(new URL('../data/games.json', import.meta.url), JSON.stringify(output, null, 2), 'utf-8');
console.log(`完成，共 ${games.length} 款遊戲寫入 data/games.json${missing.length ? `（${missing.length} 個 BGGID 查無資料: ${missing.join(',')}）` : ''}`);
