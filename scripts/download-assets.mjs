#!/usr/bin/env node
/**
 * Скачивает все изображения/видео с Framer (framerusercontent.com),
 * которые сейчас хотлинкаются в .dc.html кейсах, кладёт их локально
 * в project/assets/ и переписывает ссылки на относительные пути.
 *
 * Зачем: сейчас картинки тянутся с чужого CDN. Если старое портфолио на
 * Framer удалить или они сменят CDN — картинки на сайте отвалятся.
 *
 * Запуск (нужен Node 18+):
 *   node scripts/download-assets.mjs
 *
 * Скрипт идемпотентный: уже скачанные файлы повторно не качает,
 * уже переписанные ссылки не трогает. Можно запускать сколько угодно раз.
 */
import { readdir, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..', 'project');
const ASSETS_DIR = path.join(PROJECT_DIR, 'assets');

const URL_RE = /https:\/\/framerusercontent\.com\/[^\s"')]+/g;

async function exists(p) { try { await access(p); return true; } catch { return false; } }

// Стабильное имя файла: хэш всего URL (включая ?width=...) + расширение.
function localNameFor(url) {
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 16);
  const clean = url.split('?')[0];
  let ext = path.extname(clean).toLowerCase();
  if (!ext || ext.length > 6) ext = '.bin';
  return `${hash}${ext}`;
}

// Варианты URL для скачивания. Framer отдаёт 400, если запрошенный размер
// слишком большой (напр. width=3975). Поэтому если оригинальная ссылка не
// качается — пробуем умеренный размер (2048px, отличное качество для веба),
// затем исходник без параметров.
function candidates(url) {
  const base = url.split('?')[0];
  return [...new Set([url, base + '?width=2048', base + '?scale-down-to=2048', base])];
}

async function fetchOk(u) {
  const res = await fetch(u, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://proud-closet-379508.framer.app/',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function download(url, dest) {
  if (await exists(dest)) return 'cached';
  let lastErr;
  for (const u of candidates(url)) {
    try {
      const res = await fetchOk(u);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
      return 'downloaded';
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function main() {
  await mkdir(ASSETS_DIR, { recursive: true });

  const files = (await readdir(PROJECT_DIR)).filter((f) => f.endsWith('.dc.html'));

  // 1) Собрать все уникальные URL по всем файлам
  const fileContents = new Map();
  const allUrls = new Set();
  for (const f of files) {
    const full = path.join(PROJECT_DIR, f);
    const html = await readFile(full, 'utf8');
    fileContents.set(f, html);
    for (const m of html.matchAll(URL_RE)) allUrls.add(m[0]);
  }

  console.log(`Найдено уникальных ссылок на Framer: ${allUrls.size}`);
  if (allUrls.size === 0) {
    console.log('Нечего скачивать — возможно, уже всё локально. Готово.');
    return;
  }

  // 2) Скачать каждый URL, построить карту url -> локальное имя
  const urlToName = new Map();
  let ok = 0, cached = 0, failed = 0;
  for (const url of allUrls) {
    const name = localNameFor(url);
    const dest = path.join(ASSETS_DIR, name);
    try {
      const status = await download(url, dest);
      urlToName.set(url, name);
      if (status === 'downloaded') { ok++; process.stdout.write('.'); }
      else { cached++; process.stdout.write('·'); }
    } catch (e) {
      failed++;
      console.log(`\n  ✗ ${url}\n    ${e.message}`);
    }
  }
  console.log(`\nСкачано: ${ok}, из кэша: ${cached}, ошибок: ${failed}`);

  // 3) Переписать ссылки в каждом файле на относительные (assets/<имя>)
  let rewritten = 0;
  for (const [f, html] of fileContents) {
    let out = html;
    for (const [url, name] of urlToName) {
      out = out.split(url).join(`assets/${name}`);
    }
    if (out !== html) {
      await writeFile(path.join(PROJECT_DIR, f), out);
      rewritten++;
      console.log(`  ✓ переписан: ${f}`);
    }
  }
  console.log(`\nГотово. Файлов обновлено: ${rewritten}.`);
  console.log('Не забудь закоммитить project/assets/ и изменённые .dc.html.');
}

main().catch((e) => { console.error(e); process.exit(1); });
