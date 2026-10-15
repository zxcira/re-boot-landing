// ============================================================================
// Cloudflare Pages Function: POST /api/lead
// Принимает заявку с лендинга и пересылает владельцу в Telegram.
//
// Переменные окружения (Settings → Environment variables в Cloudflare Pages):
//   TELEGRAM_BOT_TOKEN  — токен бота от @BotFather (обязателен для Telegram)
//   TELEGRAM_CHAT_ID    — id чата/канала, куда слать заявки
//   LEADS_WEBHOOK_URL   — (необязательно) любой вебхук, получит тот же JSON
//
// Без токена функция всё равно отвечает 200 и просто ничего не отправляет —
// форма на лендинге не «падает».
// ============================================================================

export async function onRequestPost(context) {
  const { request, env } = context

  let data
  try {
    data = await request.json()
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400)
  }

  const name = str(data.name)
  const phone = str(data.phone)
  const digits = phone.replace(/\D/g, '')
  if (name.length < 2 || digits.length < 10) {
    return json({ ok: false, error: 'invalid_lead' }, 400)
  }

  const lead = {
    name,
    phone,
    car: str(data.car),
    service: str(data.service),
    page: str(data.page),
    receivedAt: new Date().toISOString(),
    ip: request.headers.get('cf-connecting-ip') || '',
  }

  let delivered = false

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    delivered = await sendToTelegram(env, lead)
  }

  if (env.LEADS_WEBHOOK_URL) {
    try {
      await fetch(env.LEADS_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(lead),
      })
    } catch {
      // вебхук — необязательный канал, ошибку не пробрасываем
    }
  }

  return json({ ok: true, delivered })
}

export async function onRequestGet() {
  return json({ ok: true, hint: 'Отправьте POST с JSON: {name, phone, car, service}' })
}

async function sendToTelegram(env, lead) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
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
    lead.page ? `Страница: ${lead.page}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function str(v) {
  return typeof v === 'string' ? v.trim().slice(0, 500) : ''
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
