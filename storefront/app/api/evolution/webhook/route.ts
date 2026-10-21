import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// ============ CONFIG ============
const EVO_URL = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '')
const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE || 'eee'
const EVO_KEY = process.env.EVOLUTION_API_KEY || ''
const OPENAI_KEY = process.env.OPENAI_API_KEY || ''
const FOOTER = 'TodoEnUno SV | Envío Gratis 🚚'

const supabase = createClient(
  process.env.SUPABASE_URL?.startsWith('http')
    ? process.env.SUPABASE_URL
    : `https://${process.env.SUPABASE_URL || 'trgywmhxmkbjfcdvxpnz'}.supabase.co`,
  process.env.SUPABASE_SERVICE_KEY || '',
  { auth: { persistSession: false } }
)

// ============ TIPOS ============
type Producto = {
  sku: string
  nombre_completo: string
  precio: number | null
  talla: string | null
  color: string | null
  image_url: string | null
  qty: number
  state: string
}

type Estado = {
  telefono: string
  nombre_cliente: string | null
  direccion: string | null
  metodo_pago: string | null
  paso: string | null
  last_nombre: string | null
  last_sku: string | null
}

type Boton = { displayText: string; id?: string }

// ============ HELPERS ============
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const norm = (s: string) =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const getKey = (jid: string) => (jid || '').replace(/\D/g, '').slice(-11)

const fmtPrecio = (p: number | null) =>
  p === null || p === undefined || isNaN(Number(p)) ? '' : `$${Number(p).toFixed(2).replace(/\.00$/, '')}`

const BOTON_IDS: Record<string, string> = {
  'ver catalogo': 'catalogo',
  'ver catálogo': 'catalogo',
  asesor: 'asesor',
  'lo quiero': 'lo_quiero',
  'ver mas': 'catalogo',
  duda: 'duda',
}

function evoHeaders() {
  return {
    'Content-Type': 'application/json',
    apikey: EVO_KEY,
    'User-Agent': 'axios/1.13.2',
  }
}

// ============ ENVÍO WHATSAPP ============
async function sendText(number: string, text: string) {
  const res = await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, {
    method: 'POST',
    headers: evoHeaders(),
    body: JSON.stringify({ number, text }),
  })
  if (!res.ok) console.error('sendText fail', res.status, await res.text().catch(() => ''))
  return res.ok
}

async function sendWhatsApp(number: string, text: string, botones?: Boton[]) {
  try {
    if (botones && botones.length) {
      const res = await fetch(`${EVO_URL}/message/sendButtons/${EVO_INSTANCE}`, {
        method: 'POST',
        headers: evoHeaders(),
        body: JSON.stringify({
          number,
          title: 'TodoEnUno',
          description: text,
          text,
          footer: FOOTER,
          buttons: botones.slice(0, 3).map((b) => ({
            type: 'reply',
            displayText: b.displayText,
            id: b.id || BOTON_IDS[norm(b.displayText)] || b.displayText,
          })),
        }),
      })
      if (res.ok) return true
      console.error('sendButtons fail -> fallback', res.status)
    }
  } catch (e) {
    console.error('sendButtons error -> fallback', e)
  }
  const extra = botones?.length
    ? `\n\n${botones.map((b) => `👉 ${b.displayText}`).join('\n')}`
    : ''
  return sendText(number, text + extra)
}

// ============ MEMORIA ============
async function getState(tel: string): Promise<Estado> {
  const { data } = await supabase.from('whatsapp_state').select('*').eq('telefono', tel).maybeSingle()
  return (
    (data as Estado) || {
      telefono: tel,
      nombre_cliente: null,
      direccion: null,
      metodo_pago: null,
      paso: null,
      last_nombre: null,
      last_sku: null,
    }
  )
}

async function saveState(st: Estado) {
  const { error } = await supabase.from('whatsapp_state').upsert(st, { onConflict: 'telefono' })
  if (error) console.error('saveState', error.message)
}

async function getHistory(tel: string) {
  const { data } = await supabase
    .from('whatsapp_conversations')
    .select('entrada, respuesta')
    .eq('telefono', tel)
    .order('created_at', { ascending: false })
    .limit(6)
  return (data || []).reverse()
}

async function saveConv(tel: string, entrada: string, respuesta: string) {
  await supabase.from('whatsapp_conversations').insert({ telefono: tel, entrada, respuesta })
}

// ============ PRODUCTOS ============
async function getDisponibles(): Promise<Producto[]> {
  const { data: vars } = await supabase
    .from('productos_variantes')
    .select('sku, nombre_completo, precio, talla, color, image_url')
    .limit(5000)
  const { data: inv } = await supabase.from('inventory_cache').select('sku, qty, state').limit(5000)

  const invMap = new Map<string, { qty: number; state: string }>()
  for (const i of inv || []) invMap.set(i.sku, { qty: Number(i.qty) || 0, state: i.state })

  const out: Producto[] = []
  for (const v of vars || []) {
    const i = invMap.get(v.sku)
    if (!i) continue
    // DISPONIBLE o TEST (vendible bajo pedido). NO_DISPONIBLE se excluye.
    if (i.state === 'NO_DISPONIBLE') continue
    if (i.state !== 'DISPONIBLE' && i.state !== 'TEST') continue
    out.push({ ...(v as any), qty: i.qty, state: i.state })
  }
  return out
}

const estadoTxt = (p: Producto) =>
  p.state === 'DISPONIBLE' && p.qty > 0 ? '✅ Entrega inmediata' : '✨ Disponible bajo pedido 3-5 días'

function buscar(msg: string, disp: Producto[]): Producto | null {
  const q = norm(msg)
  if (!q) return null
  const stop = new Set([
    'precio', 'cuanto', 'cuesta', 'vale', 'tienen', 'tiene', 'hay', 'quiero', 'busco', 'info',
    'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'que', 'es', 'son', 'para', 'por',
    'me', 'mandeme', 'mande', 'dame', 'ver', 'como', 'donde', 'tienes', 'precios', 'costo',
  ])
  const palabras = q.split(' ').filter((w) => w.length > 2 && !stop.has(w))
  if (!palabras.length) return null

  // 1) coincidencia de frase completa
  const frase = palabras.join(' ')
  let hit = disp.find((p) => norm(p.nombre_completo).includes(frase))
  if (hit) return hit
  // 2) todas las palabras
  hit = disp.find((p) => {
    const n = norm(p.nombre_completo)
    return palabras.every((w) => n.includes(w))
  })
  if (hit) return hit
  // 3) la palabra más fuerte (la más larga) o singular simple
  const sing = (w: string) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)
  const ordenadas = [...palabras].sort((a, b) => b.length - a.length)
  for (const w of ordenadas) {
    const s = sing(w)
    const h = disp.find((p) => norm(p.nombre_completo).includes(s))
    if (h) return h
  }
  return null
}

function fichaProducto(p: Producto) {
  const l = [`🛍️ *${p.nombre_completo}*`]
  if (p.precio !== null && p.precio !== undefined) l.push(`💰 Precio: *${fmtPrecio(p.precio)}*`)
  if (p.talla) l.push(`📏 Talla: ${p.talla}`)
  if (p.color) l.push(`🎨 Color: ${p.color}`)
  l.push(`📦 Estado: ${estadoTxt(p)}`)
  return l.join('\n')
}

// ============ DETECCIÓN ============
const esSaludo = (m: string) => /^(hola+|holi+|buenas?|buenos dias|buenas tardes|buenas noches|hey|ola|saludos|que tal)\b/.test(norm(m)) && norm(m).split(' ').length <= 4
const esListar = (m: string) =>
  /(que tienen|que tenes|que vende|catalogo|sobre que|que info|que productos|solo eso|solo de eso|solo eso|ver mas|mas productos|que mas|que hay|lista)/.test(norm(m))
const esAsesor = (m: string) => /(asesor|humano|persona real|agente|hablar con alguien|vendedor)/.test(norm(m))
const esPedir = (m: string) =>
  /(lo quiero|lo llevo|mandeme|mandame|me lo manda|quiero uno|quiero comprar|comprar|pedir|pedido|ordenar|lo_quiero|apartar)/.test(norm(m))
const esComoPedir = (m: string) => /(como (hago|pido|compro|se hace).*(pedido|pedir|comprar)|como lo pido|como compro)/.test(norm(m))
const esDuda = (m: string) => /^(duda|\?|tengo una duda|pregunta)$/.test(norm(m)) || norm(m) === 'duda'

const esDireccion = (m: string) =>
  /(colonia|col\.|escalon|san salvador|calle|avenida|av\.|pasaje|residencial|urbanizacion|reparto|municipio|depto|departamento|santa tecla|soyapango|mejicanos|apopa|ilopango|san miguel|santa ana|km|casa|numero|#)/.test(
    norm(m)
  ) || /\d/.test(m) && m.length > 15

function detectaPago(m: string): string | null {
  const n = norm(m)
  if (/efectivo|contra entrega|contraentrega|cash/.test(n)) return 'efectivo'
  if (/transfer|deposito|banco/.test(n)) return 'transferencia'
  return null
}

function detectaNombre(m: string): string | null {
  const limpio = m.trim()
  if (esDireccion(limpio) || detectaPago(limpio)) return null
  if (/\d|@|\?|!/.test(limpio)) return null
  const palabras = limpio.split(/\s+/)
  if (palabras.length < 2 || palabras.length > 4) return null
  if (!palabras.every((w) => /^[A-Za-zÁÉÍÓÚáéíóúÑñÜü'.-]+$/.test(w))) return null
  if (esSaludo(limpio) || esListar(limpio) || esPedir(limpio) || esAsesor(limpio)) return null
  return limpio.replace(/\b\w/g, (c) => c.toUpperCase())
}

// ============ OPENAI (texto bonito + objeciones, sin inventar) ============
async function openaiRespuesta(
  msg: string,
  historial: { entrada: string; respuesta: string }[],
  contexto: string
): Promise<string | null> {
  if (!OPENAI_KEY) return null
  try {
    const messages: any[] = [
      {
        role: 'system',
        content: `Eres LILI, vendedora salvadoreña de TodoEnUno SV. Hablas de vos, eres amable, corta (máximo 3 líneas), usas emojis. Cierras ventas y manejas objeciones (precio, confianza, envío). Envío GRATIS 24-72h. Pago efectivo o transferencia. NUNCA digas "no sé" ni "no tengo información"; ofrece siempre algo real del contexto. NUNCA inventes productos, precios, tallas ni colores. NUNCA muestres JSON. Responde SOLO texto plano.\n\nCONTEXTO REAL:\n${contexto}`,
      },
    ]
    for (const h of historial) {
      messages.push({ role: 'user', content: h.entrada })
      messages.push({ role: 'assistant', content: h.respuesta })
    }
    messages.push({ role: 'user', content: msg })

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.2, max_tokens: 200, messages }),
    })
    if (!res.ok) return null
    const j = await res.json()
    const t = j?.choices?.[0]?.message?.content?.trim()
    if (!t || t.startsWith('{')) return null
    return t
  } catch (e) {
    console.error('openai', e)
    return null
  }
}

// ============ MINI AGENTE ============
type Salida = { texto: string; botones?: Boton[] }

const BTN_SALUDO: Boton[] = [
  { displayText: 'Ver catálogo', id: 'catalogo' },
  { displayText: 'Asesor', id: 'asesor' },
]
const BTN_PRODUCTO: Boton[] = [
  { displayText: '✅ Lo quiero', id: 'lo_quiero' },
  { displayText: '🛍️ Ver más', id: 'catalogo' },
  { displayText: '❓ Duda', id: 'duda' },
]

function pedirFaltantes(st: Estado): string {
  const f: string[] = []
  if (!st.nombre_cliente) f.push('📝 *Nombre completo:*')
  if (!st.direccion) f.push('📍 *Dirección:* colonia, municipio, depto')
  if (!st.metodo_pago) f.push('💳 *Pago:* efectivo/transferencia')
  return f.join('\n')
}

async function miniAgente(
  tel: string,
  jid: string,
  msg: string,
  st: Estado,
  disp: Producto[],
  historial: { entrada: string; respuesta: string }[]
): Promise<Salida> {
  const n = norm(msg)

  // --- Humano ---
  if (esAsesor(msg) || n === 'asesor') {
    st.paso = 'asesor'
    await saveState(st)
    return { texto: 'Te paso con asesor 🙋‍♀️ En un momento te escribe una persona de nuestro equipo. ¡Gracias por tu paciencia! 💛' }
  }

  // --- Recolección de datos del pedido ---
  if (st.paso === 'recolectando' && st.last_sku) {
    const pago = detectaPago(msg)
    if (pago) st.metodo_pago = pago
    else if (esDireccion(msg) && !st.direccion) st.direccion = msg.trim()
    else {
      const nombre = !st.nombre_cliente ? detectaNombre(msg) : null
      if (nombre) st.nombre_cliente = nombre
      else if (!st.direccion && msg.trim().length > 12 && !esPedir(msg)) st.direccion = msg.trim()
    }

    const okN = !!st.nombre_cliente
    const okD = !!st.direccion
    const okP = !!st.metodo_pago

    if (okN && okD && okP) {
      const prod = disp.find((p) => p.sku === st.last_sku)
      const nombreProd = prod?.nombre_completo || st.last_nombre || 'Producto'
      const total = prod?.precio ?? 0
      const { error } = await supabase.from('whatsapp_orders').insert({
        telefono: tel,
        nombre: st.nombre_cliente,
        telefono_cliente: tel,
        direccion: st.direccion,
        items: [{ sku: st.last_sku, nombre: nombreProd, qty: 1, precio: total }],
        total,
        estado: 'nuevo',
        metodo_pago: st.metodo_pago,
      })
      if (error) console.error('order insert', error.message)
      st.paso = 'confirmado'
      await saveState(st)
      return {
        texto:
          `✅ *PEDIDO CONFIRMADO* 🎉\n\n` +
          `🛍️ ${nombreProd}\n` +
          (total ? `💰 Total: *${fmtPrecio(total)}*\n` : '') +
          `👤 ${st.nombre_cliente}\n📍 ${st.direccion}\n💳 ${st.metodo_pago}\n\n` +
          `🚚 *Envío GRATIS 24-72h*\n¡Gracias por tu compra! 💛`,
      }
    }
    await saveState(st)
    return { texto: `¡Perfecto! Solo me falta 😊\n\n${pedirFaltantes(st)}` }
  }

  // --- Saludo ---
  if (esSaludo(msg)) {
    return {
      texto: `¡Hola! 👋 Soy *Lili* de TodoEnUno SV 💛\nTenemos *${disp.length}* productos disponibles con envío gratis 🚚\n¿Qué te gustaría ver?`,
      botones: BTN_SALUDO,
    }
  }

  // --- Cómo hacer pedido ---
  if (esComoPedir(msg)) {
    if (st.last_sku) {
      st.paso = 'recolectando'
      await saveState(st)
      return { texto: `¡Muy fácil! 😊 Solo necesito:\n\n${pedirFaltantes(st)}\n\nY listo, envío GRATIS 24-72h 🚚` }
    }
    return {
      texto: '¡Fácil! 😊 Elegí un producto, tocá *Lo quiero* y te pido nombre, dirección y forma de pago. Envío GRATIS 🚚',
      botones: [{ displayText: 'Ver catálogo', id: 'catalogo' }, { displayText: 'Asesor', id: 'asesor' }],
    }
  }

  // --- Pedir (lo quiero) ---
  if (esPedir(msg) || n === 'lo quiero') {
    const prodMsg = buscar(msg, disp)
    if (prodMsg) {
      st.last_sku = prodMsg.sku
      st.last_nombre = prodMsg.nombre_completo
    }
    if (st.last_sku) {
      st.paso = 'recolectando'
      await saveState(st)
      return {
        texto: `¡Excelente elección! 🎉 *${st.last_nombre}*\n\n${pedirFaltantes(st)}`,
      }
    }
    // sin producto previo -> listar
  }

  // --- Duda ---
  if (esDuda(msg)) {
    const ctx = st.last_nombre ? `Producto en conversación: ${st.last_nombre}` : `Catálogo con ${disp.length} productos`
    const r = await openaiRespuesta('Tengo una duda', historial, ctx)
    return {
      texto: r || '¡Claro! Preguntame lo que quieras 😊 Envío GRATIS 24-72h, pagás efectivo o transferencia 💳',
      botones: st.last_sku ? BTN_PRODUCTO : BTN_SALUDO,
    }
  }

  // --- Listar ---
  const listar = () => {
    const top = disp.slice(0, 7)
    const lineas = top.map((p) => `• *${p.nombre_completo}*${p.precio != null ? ` - ${fmtPrecio(p.precio)}` : ''}`)
    return {
      texto: `¡Mirá lo que tenemos! ✨\n\n${lineas.join('\n')}\n\nEscribime el nombre del que te guste 😊`,
      botones: [{ displayText: 'Asesor', id: 'asesor' }, { displayText: 'Ver catálogo', id: 'catalogo' }] as Boton[],
    }
  }

  if (esListar(msg) || n === 'catalogo') {
    if (disp.length) {
      const top = disp.slice(0, 7)
      st.last_sku = st.last_sku || null
      await saveState(st)
      return listar()
    }
  }

  // --- Info / búsqueda dinámica ---
  const prod = buscar(msg, disp)
  if (prod) {
    st.last_sku = prod.sku
    st.last_nombre = prod.nombre_completo
    st.paso = 'info'
    await saveState(st)
    return { texto: fichaProducto(prod), botones: BTN_PRODUCTO }
  }

  // --- Sin coincidencia: OpenAI con catálogo real o catálogo ---
  if (disp.length) {
    const muestra = disp
      .slice(0, 7)
      .map((p) => `${p.nombre_completo} ${fmtPrecio(p.precio)}`)
      .join('; ')
    const r = await openaiRespuesta(
      msg,
      historial,
      `El cliente pidió algo que no está en catálogo. Ofrece amablemente uno de estos productos REALES: ${muestra}`
    )
    const l = listar()
    return {
      texto: r ? `${r}\n\n${l.texto}` : `Esa no la tengo a mano, pero mirá lo que sí tenemos 💛\n\n${l.texto}`,
      botones: l.botones,
    }
  }

  return {
    texto: '¡Hola! 💛 Estoy actualizando el catálogo, en un momento te ayudo. ¿Querés que te pase con un asesor?',
    botones: [{ displayText: 'Asesor', id: 'asesor' }],
  }
}

// ============ WEBHOOK ============
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const event = String(body?.event || '').toLowerCase()
    if (event && !event.includes('messages.upsert') && !event.includes('messages_upsert')) {
      return NextResponse.json({ ok: true, ignored: event })
    }

    const data = body?.data || {}
    const key = data?.key || {}
    if (key.fromMe) return NextResponse.json({ ok: true, ignored: 'fromMe' })

    const jid: string = key.remoteJid || ''
    if (!jid || jid.includes('@g.us') || jid.includes('status@broadcast')) {
      return NextResponse.json({ ok: true, ignored: 'jid' })
    }

    const m = data?.message || {}
    const raw: string = (
      m.conversation ||
      m.extendedTextMessage?.text ||
      m.imageMessage?.caption ||
      m.buttonsResponseMessage?.selectedButtonId ||
      m.buttonsResponseMessage?.selectedDisplayText ||
      m.listResponseMessage?.singleSelectReply?.selectedRowId ||
      ''
    ).trim()

    if (!raw) return NextResponse.json({ ok: true, ignored: 'empty' })

    const tel = getKey(jid)
    const number = jid.split('@')[0]

    // ---- Buffer anti-spam: inserta, espera, une todo ----
    const { data: ins } = await supabase
      .from('whatsapp_buffer')
      .insert({ telefono: tel, mensaje: raw })
      .select('created_at')
      .maybeSingle()
    const miTs = ins?.created_at

    await sleep(3500)

    const { data: buf } = await supabase
      .from('whatsapp_buffer')
      .select('mensaje, created_at')
      .eq('telefono', tel)
      .order('created_at', { ascending: true })

    if (!buf || !buf.length) return NextResponse.json({ ok: true, ignored: 'buffer-procesado' })

    // Solo responde la última invocación (evita respuestas duplicadas)
    const ultimo = buf[buf.length - 1].created_at
    if (miTs && ultimo !== miTs) return NextResponse.json({ ok: true, ignored: 'no-last' })

    const unido = buf.map((b: any) => b.mensaje).join(' | ')
    await supabase.from('whatsapp_buffer').delete().eq('telefono', tel)

    // Para detección usamos el último mensaje; el unido va al historial
    const msg = buf.length > 1 ? buf[buf.length - 1].mensaje : unido
    const msgAgente = buf.length > 1 ? buf.map((b: any) => b.mensaje).join(' ') : unido

    // Mapea ids de botones
    const idMap: Record<string, string> = {
      lo_quiero: 'lo quiero',
      catalogo: 'catalogo',
      asesor: 'asesor',
      duda: 'duda',
    }
    const msgFinal = idMap[norm(msg)] || (buf.length > 1 && esSaludo(msg) ? msg : msgAgente)

    const [st, disp, historial] = await Promise.all([getState(tel), getDisponibles(), getHistory(tel)])

    const out = await miniAgente(tel, jid, msgFinal, st, disp, historial)

    // Guarda last_sku/last_nombre siempre
    const stFinal = await getState(tel)
    if (st.last_sku && !stFinal.last_sku) {
      stFinal.last_sku = st.last_sku
      stFinal.last_nombre = st.last_nombre
      await saveState(stFinal)
    }

    await sendWhatsApp(number, out.texto, out.botones)
    await saveConv(tel, unido, out.texto)

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('webhook error', e)
    return NextResponse.json({ ok: true, error: String(e?.message || e) })
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, service: 'todoenuno-whatsapp-lili' })
}
