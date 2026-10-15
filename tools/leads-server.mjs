// ============================================================================
// Локальный сервер лендинга Re:boot с приёмом заявок.
//
// Запуск:   node tools/leads-server.mjs          (порт 4181)
//           node tools/leads-server.mjs 4182     (другой порт)
//
// Что делает:
//   • отдаёт файлы сайта (index.html, assets/…);
//   • принимает POST /api/lead;
//   • печатает заявку в консоль;
//   • дописывает строку в заявки.csv (открывается в Excel);
//   • если заданы переменные окружения TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID —
//     дублирует заявку в Telegram.
//
// PowerShell (Windows), пример с Telegram:
//   $env:TELEGRAM_BOT_TOKEN="123456:ABC…"; $env:TELEGRAM_CHAT_ID="123456789"
//   node tools/leads-server.mjs
// ============================================================================

import { createServer } from 'node:http'
import { readFile, appendFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PORT = Number(process.argv[2] || process.env.PORT || 4181)
const CSV = join(ROOT, 'заявки.csv')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`)

    if (req.method === 'POST' && url.pathname === '/api/lead') {
      return await handleLead(req, res)
    }
    if (url.pathname === '/api/lead') {
      return sendJson(res, 200, { ok: true, hint: 'Отправьте POST с JSON заявкой' })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
    }
    return await serveStatic(url.pathname, req, res)
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
  }
})

server.listen(PORT, () => {
  console.log(`Re:boot лендинг:  http://localhost:${PORT}/`)
  console.log(`Заявки:           POST /api/lead → заявки.csv`)
  const tg = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
  console.log(`Telegram:         ${tg ? 'включён' : 'выключен (не заданы TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)'}`)
})

async function serveStatic(pathname, req, res) {
  let rel = decodeURIComponent(pathname)
  if (rel === '/' || rel === '') rel = '/index.html'
  const safe = normalize(rel).replace(/^([/\\])+/, '')
  const file = join(ROOT, safe)

  // защита от выхода за пределы папки сайта
  if (!file.startsWith(ROOT + sep) && file !== ROOT) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' })
  }
  if (!existsSync(file)) {
    return sendText(res, 404, '404 — не найдено')
  }
  const info = await stat(file)
  if (info.isDirectory()) return sendText(res, 403, 'forbidden')

  const body = await readFile(file)
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

async function handleLead(req, res) {
  const raw = await readBody(req, 64 * 1024)
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad_json' })
  }

  const name = str(data.name)
  const phone = str(data.phone)
  if (name.length < 2 || phone.replace(/\D/g, '').length < 10) {
    return sendJson(res, 400, { ok: false, error: 'invalid_lead' })
  }

  const lead = {
    name,
    phone,
    car: str(data.car),
    service: str(data.service),
    page: str(data.page),
    receivedAt: new Date().toISOString(),
    ip: req.socket.remoteAddress || '',
  }

  await saveCsv(lead)
  printLead(lead)

  const delivered = await sendToTelegram(lead)
  return sendJson(res, 200, { ok: true, delivered })
}

async function saveCsv(lead) {
  if (!existsSync(CSV)) {
    await appendFile(CSV, '\uFEFFДата;Имя;Телефон;Автомобиль;Услуга;Страница\r\n', 'utf8')
  }
  const when = new Date(lead.receivedAt).toLocaleString('ru-RU', { timeZone: 'Asia/Yekaterinburg' })
  const row = [when, lead.name, lead.phone, lead.car, lead.service, lead.page]
    .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
    .join(';')
  await appendFile(CSV, row + '\r\n', 'utf8')
}

function printLead(lead) {
  const line = '─'.repeat(52)
  console.log('\n' + line)
  console.log('  🔔  НОВАЯ ЗАЯВКА')
  console.log(line)
  console.log('  Услуга:  ' + (lead.service || '—'))
  console.log('  Имя:     ' + lead.name)
  console.log('  Телефон: ' + lead.phone)
  console.log('  Авто:    ' + (lead.car || '—'))
  console.log('  Время:   ' + new Date(lead.receivedAt).toLocaleString('ru-RU', { timeZone: 'Asia/Yekaterinburg' }))
  console.log(line + '\n')
}

async function sendToTelegram(lead) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chat = process.env.TELEGRAM_CHAT_ID
  if (!token || !chat) return false
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text: formatLead(lead),
        disable_web_page_preview: true,
      }),
    })
    return res.ok
  } catch {
    return false
  }
}

function formatLead(lead) {
  const when = new Date(lead.receivedAt).toLocaleString('ru-RU', { timeZone: 'Asia/Yekaterinburg' })
  return [
    '🔔 Новая заявка Re:boot',
    `Услуга: ${lead.service || '—'}`,
    `Имя: ${lead.name}`,
    `Телефон: ${lead.phone}`,
    `Авто: ${lead.car || '—'}`,
    `Время: ${when} (Екб)`,
  ].join('\n')
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('payload_too_large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function str(v) {
  return typeof v === 'string' ? v.trim().slice(0, 500) : ''
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(buf)
}

function sendText(res, status, text) {
  const buf = Buffer.from(text, 'utf8')
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(buf)
}
