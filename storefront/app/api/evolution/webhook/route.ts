import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 30

const AGENTE = 'Todd'
const BUFFER_MS = 2500
const CACHE_MS = 30000

const EVO_URL = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '')
const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE || 'eee'
const EVO_KEY = process.env.EVOLUTION_API_KEY || ''
const OPENAI_KEY = process.env.OPENAI_API_KEY || ''

const SB_URL_RAW = process.env.SUPABASE_URL || 'https://trgywmhxmkbjfcdvxpnz.supabase.co'
const SB_URL = SB_URL_RAW.startsWith('http') ? SB_URL_RAW : `https://${SB_URL_RAW}.supabase.co`
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || ''
// Evita que una variable ausente rompa el módulo durante el build; POST valida la config.
const supabase = createClient(SB_URL, SB_KEY || 'missing-service-key', { auth: { persistSession: false } })

type Producto = {
  sku: string
  nombre_completo: string
  precioNum: number
  talla: string | null
  color: string | null
  qty: number
  state: string
  es_test: boolean
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
type Conv = { entrada: string; respuesta: string }

// ============ HELPERS ============
const norm = (s: string) =>
  (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
const getKey = (s: string) => (s || '').replace(/\D/g, '').slice(-11)
const cleanNumber = (jid: string) => (jid || '').replace(/:\d+(?=@)/, '').split('@')[0].replace(/\D/g, '')
const fmtPrecio = (p: number) => `$${Number(p || 0).toFixed(2).replace(/\.00$/, '')}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const estadoTxt = (p: Producto) => {
  if (p.state === 'DISPONIBLE') return '✅ Entrega inmediata'
  if (p.state === 'TEST' && p.qty === 0) return '✨ Disponible bajo pedido (3–5 días)'
  if (p.state === 'TEST') return '✨ Disponibilidad por confirmar'
  return 'Disponibilidad por confirmar'
}

const pick = (o: any, keys: string[]) => {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]
  return null
}

// ============ EVOLUTION ============
function evoHeaders() {
  return { 'Content-Type': 'application/json', apikey: EVO_KEY, 'User-Agent': 'axios/1.13.2' }
}
async function sendText(num: string, text: string) {
  try {
    const r = await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, {
      method: 'POST',
      headers: evoHeaders(),
      body: JSON.stringify({ number: num, text }),
    })
    if (!r.ok) console.error('sendText', r.status, await r.text().catch(() => ''))
    return r.ok
  } catch (e) {
    console.error('sendText error', e)
    return false
  }
}


async function sendButtons(num: string, text: string, labels: string[]) {
  try {
    const r = await fetch(`${EVO_URL}/message/sendButtons/${EVO_INSTANCE}`, {
      method: 'POST',
      headers: evoHeaders(),
      body: JSON.stringify({
        number: num,
        text,
        footer: 'TodoEnUno SV | Envío Gratis 🚚',
        buttons: labels.slice(0, 3).map(displayText => ({ displayText })),
      }),
    })
    if (!r.ok) console.error('sendButtons', r.status, await r.text().catch(() => ''))
    return r.ok
  } catch (e) {
    console.error('sendButtons error', e)
    return false
  }
}
async function sendWhatsApp(num: string, text: string, labels: string[] = []) {
  if (labels.length && await sendButtons(num, text, labels)) return true
  return sendText(num, text)
}
function botonesPara(msg: string, respuesta: string): string[] {
  if (/¿te lo aparto\?|responde:\s*lo quiero/i.test(respuesta)) {
    return ['✅ Lo quiero', '🛍️ Ver más', '❓ Duda']
  }
  const n = norm(msg)
  if (esSaludo(msg) || esListar(msg) || n === 'catalogo' || /que te gustaria ver|escribi: catalogo/i.test(norm(respuesta))) {
    return ['🛍️ Ver catálogo', '👩‍💼 Asesor']
  }
  return []
}

// ============ MEMORIA ============
async function getState(tel: string): Promise<Estado> {
  const { data, error } = await supabase.from('whatsapp_state').select('*').eq('telefono', tel).maybeSingle()
  if (error) console.error('getState', error.message, 'telefono:', tel)
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
  const base: any = {
    telefono: st.telefono,
    nombre_cliente: st.nombre_cliente,
    direccion: st.direccion,
    metodo_pago: st.metodo_pago,
    paso: st.paso,
    last_nombre: st.last_nombre,
    last_sku: st.last_sku,
  }
  let r = await supabase.from('whatsapp_state').upsert({ ...base, updated_at: new Date().toISOString() }, { onConflict: 'telefono' })
  if (r.error) {
    // la tabla puede no tener updated_at
    r = await supabase.from('whatsapp_state').upsert(base, { onConflict: 'telefono' })
    if (r.error) console.error('saveState', r.error.message)
  }
}
async function saveConv(tel: string, entrada: string, respuesta: string) {
  const { error } = await supabase.from('whatsapp_conversations').insert({ telefono: tel, entrada, respuesta })
  if (error) console.error('saveConv', error.message)
}
async function getHistory(tel: string): Promise<Conv[]> {
  const { data } = await supabase
    .from('whatsapp_conversations')
    .select('entrada,respuesta')
    .eq('telefono', tel)
    .order('created_at', { ascending: false })
    .limit(6)
  return ((data as Conv[]) || []).reverse()
}

// ============ PRODUCTOS ============
async function fetchAll(table: string, cols: string) {
  const rows: any[] = []
  let from = 0
  let error: string | null = null
  for (;;) {
    const { data, error: e } = await supabase.from(table).select(cols).range(from, from + 999)
    if (e) {
      error = e.message
      console.error(`${table} err`, e.message)
      break
    }
    const d = (data as any[]) || []
    if (!d.length) break
    rows.push(...d)
    if (d.length < 1000) break
    from += 1000
  }
  return { rows, error }
}

let cache: { t: number; v: Producto[] } | null = null

async function getDisponibles(force = false): Promise<Producto[]> {
  if (!force && cache && Date.now() - cache.t < CACHE_MS) return cache.v

  const [vars, inv] = await Promise.all([
    fetchAll('productos_variantes', '*'),
    fetchAll('inventory_cache', '*'),
  ])
  if (vars.error || inv.error) {
    if (cache?.v.length) return cache.v
    return []
  }

  const invMap = new Map<string, { qty: number; state: string }>()
  for (const i of inv.rows) {
    invMap.set(String(i.sku), {
      qty: Number(pick(i, ['qty', 'stock', 'quantity'])) || 0,
      state: String(pick(i, ['state', 'estado']) || '').toUpperCase(),
    })
  }

  const out: Producto[] = []
  for (const v of vars.rows) {
    const sku = String(pick(v, ['sku', 'default_code']) || '')
    const nombre = String(pick(v, ['nombre_completo', 'nombre', 'name']) || '')
    if (!sku || !nombre) continue

    const precioNum = Number(String(pick(v, ['precio', 'price', 'list_price']) ?? 0).replace(/[,$\s]/g, '')) || 0
    if (precioNum <= 0) continue

    const estadoVar = String(v.estado || '').toUpperCase()
    const i = invMap.get(sku)
    const state = String(i?.state || estadoVar || '').toUpperCase()
    const qty = i?.qty ?? (Number(v.stock) || 0)
    const esTest = state === 'TEST' || v.es_test === true || v.es_test === 'true'

    // Nunca vender un SKU marcado explícitamente como NO_DISPONIBLE.
    if (state === 'NO_DISPONIBLE' || estadoVar === 'NO_DISPONIBLE') continue
    // No afirmar disponibilidad cuando la sincronización no nos dio un estado reconocible.
    if (state !== 'DISPONIBLE' && state !== 'TEST') continue

    out.push({
      sku,
      nombre_completo: nombre,
      precioNum,
      talla: v.talla || null,
      color: v.color || null,
      qty,
      state,
      es_test: esTest,
    })
  }
  console.log('BOT disponibles', out.length, 'vars', vars.rows.length, 'inv', inv.rows.length, vars.error || '', inv.error || '')
  if (out.length) cache = { t: Date.now(), v: out }
  return out
}

function distintos(disp: Producto[], n: number): Producto[] {
  const seen = new Set<string>()
  const out: Producto[] = []
  for (const p of disp) {
    const k = norm(p.nombre_completo)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(p)
    if (out.length >= n) break
  }
  return out
}

function fichaProducto(p: Producto) {
  const l = [`🛍️ *${p.nombre_completo}*`, `💰 Precio: *${fmtPrecio(p.precioNum)}*`]
  if (p.talla) l.push(`📏 Talla: *${p.talla}*`)
  if (p.color) l.push(`🎨 Color: *${p.color}*`)
  l.push(`📦 ${estadoTxt(p)}`, '', '¿Te lo aparto? 😊 Responde: Lo quiero')
  return l.join('\n')
}

function listar(disp: Producto[], n = 7) {
  return distintos(disp, n)
    .map((p) => {
      const extra: string[] = []
      if (p.talla) extra.push(`Talla ${p.talla}`)
      if (p.color) extra.push(p.color)
      return `• *${p.nombre_completo}*${extra.length ? ` (${extra.join(' - ')})` : ''} - ${fmtPrecio(p.precioNum)}`
    })
    .join('\n')
}

function buscarProducto(msg: string, disp: Producto[]): Producto | null {
  const q = norm(msg)
  if (!q) return null
  const stop = new Set([
    'precio', 'cuanto', 'cuesta', 'vale', 'tienen', 'tiene', 'hay', 'quiero', 'quisiera', 'busco', 'info',
    'informacion', 'informaciones', 'mas', 'sobre', 'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'que',
    'es', 'son', 'para', 'por', 'me', 'mandeme', 'mandame', 'ver', 'como', 'donde', 'tienes', 'lo', 'llevo',
    'comprar', 'pedido', 'pedir', 'catalogo', 'hola', 'buenas', 'buenos', 'dias', 'tarde', 'noches', 'producto',
    'productos', 'dame', 'muestrame', 'mostrar', 'necesito', 'venden', 'vender', 'disponible', 'disponibles',
  ])
  const words = q.split(' ').filter(w => w.length > 2 && !stop.has(w))
  if (!words.length) return null
  const compactQ = q.replace(/\s/g, '')
  let best: Producto | null = null
  let bestScore = 0

  for (const p of disp) {
    const name = norm(p.nombre_completo)
    const compactName = name.replace(/\s/g, '')
    if (compactQ.length >= 5 && (compactName.includes(compactQ) || compactQ.includes(compactName))) return p
    const nameWords = name.split(' ')
    let hits = 0
    for (const w of words) {
      const singular = w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w
      const match = nameWords.some(nw => nw === w || nw === singular || nw.startsWith(w) || nw.startsWith(singular) || w.startsWith(nw))
      if (match) hits++
    }
    const score = hits / words.length
    if (score > bestScore) {
      bestScore = score
      best = p
    }
  }
  // Evita elegir un artículo por una sola palabra incidental en consultas de varias palabras.
  const minScore = words.length === 1 ? 1 : 0.6
  return bestScore >= minScore ? best : null
}

function productoDeUltimaRespuesta(hist: Conv[], disp: Producto[]): Producto | null {
  const last = hist[hist.length - 1]?.respuesta || ''
  // Solo recuperar la ficha explícita más reciente; nunca inferir un SKU desde un catálogo general.
  if (!/¿te lo aparto\?|responde:\s*lo quiero/i.test(last)) return null
  const match = last.match(/🛍️?\s*\*([^*]+)\*/i)
  if (!match?.[1]) return null
  const nombre = norm(match[1])
  return disp.find(p => norm(p.nombre_completo) === nombre) || null
}
function buscarPorTallaColor(msg: string, disp: Producto[]): Producto[] {
  const n = norm(msg)
  return disp
    .filter((p) => (p.talla && n.split(' ').includes(norm(p.talla))) || (p.color && n.includes(norm(p.color))))
    .slice(0, 8)
}

// ============ DETECCIÓN ============
const esSaludo = (m: string) => {
  const partes = (m || '').split('|').map(norm).filter(Boolean)
  const saludo = /^(hola+|holi+|buenas?|buenos dias|buenas tardes|buenas noches|hey|ola|saludos|que tal)$/
  return partes.length > 0 && partes.length <= 4 && partes.every(p => saludo.test(p))
}
const esListar = (m: string) =>
  /(que tienen|que tenes|que vende|catalogo|sobre que|que info|que productos|solo eso|solo de eso|ver mas|mas productos|que mas|que hay|lista|muestrame opciones)/.test(norm(m))
const esAsesor = (m: string) => /(asesor|humano|persona real|agente|hablar con alguien|vendedor|atencion al cliente)/.test(norm(m))
const esPedir = (m: string) =>
  /(lo quiero|lo llevo|mandeme|mandame|me lo manda|quiero uno|quiero comprar|comprar|pedir|pedido|ordenar|lo_quiero|apartar|confirmar pedido)/.test(norm(m))
const esComoPedir = (m: string) => /(como (hago|pido|compro|se hace).*(pedido|pedir|comprar)|como lo pido)/.test(norm(m))
const esTallaColor = (m: string) =>
  /(que talla|que tallas|tienen talla|talla s\b|talla m\b|talla l\b|talla xl|que color|que colores|tienen colores|color rojo|color azul|color negro)/.test(norm(m))
const esCancelar = (m: string) => /(cancelar|cancela|mejor no|ya no quiero)/.test(norm(m))
const esDireccion = (m: string) =>
  /\b(colonia|col|escalon|san salvador|calle|avenida|av|pasaje|residencial|municipio|depto|departamento|santa tecla|soyapango|mejicanos|apopa|ilopango|canton|caserio|lotificacion|urbanizacion|reparto|bloque|poligono|km|casa)\b/.test(norm(m)) ||
  m.includes('#') ||
  (/\d/.test(m) && m.length > 12)

function detectaPago(m: string): string | null {
  const n = norm(m)
  if (/efectivo|contra entrega|contraentrega|cash/.test(n)) return 'efectivo'
  if (/transfer|deposito|banco/.test(n)) return 'transferencia'
  return null
}
function detectaNombre(m: string): string | null {
  const t = m.trim()
  if (esDireccion(t) || detectaPago(t)) return null
  if (/[@\d\/:?!]/.test(t)) return null
  const words = t.split(/\s+/).filter(Boolean)
  if (words.length < 2 || words.length > 4) return null
  if (!words.every((w) => /^[A-Za-zÁÉÍÓÚáéíóúÑñÜü'-]+$/.test(w))) return null
  if (esSaludo(t) || esListar(t) || esPedir(t) || esAsesor(t)) return null
  return t.replace(/\b\w/g, (c) => c.toUpperCase())
}

function faltantes(st: Estado) {
  const f: string[] = []
  if (!st.nombre_cliente) f.push('📝 *Nombre completo:*')
  if (!st.direccion) f.push('📍 *Dirección:* colonia, municipio, depto')
  if (!st.metodo_pago) f.push('💳 *Pago:* efectivo/transferencia')
  return f.join('\n')
}

function recolectar(st: Estado, msg: string) {
  const partes = msg.split(/[|\n;,]+/).map((s) => s.trim()).filter(Boolean)
  let dirDeEste = false
  let algo = false
  for (const p of partes) {
    const pago = detectaPago(p)
    if (pago) {
      st.metodo_pago = pago
      algo = true
      continue
    }
    if (esDireccion(p)) {
      st.direccion = dirDeEste && st.direccion ? `${st.direccion}, ${p}` : p
      dirDeEste = true
      algo = true
      continue
    }
    if (!st.nombre_cliente) {
      const nom = detectaNombre(p)
      if (nom) {
        st.nombre_cliente = nom
        algo = true
      }
    }
  }
  if (!algo && !st.direccion && msg.trim().length > 12 && !esPedir(msg)) st.direccion = msg.trim()
}

// ============ OPENAI (solo respaldo, con catálogo real) ============
async function openaiFallback(msg: string, hist: Conv[], muestra: string): Promise<string | null> {
  if (!OPENAI_KEY) return null
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 7000)
  try {
    const messages: any[] = [
      {
        role: 'system',
        content:
          `Eres ${AGENTE}, vendedor salvadoreño de TodoEnUno SV. Hablas de vos, amable, máximo 2 líneas, con emojis. ` +
          `Cierras ventas y manejas objeciones (precio, confianza, envío). Envío GRATIS 24-72h; pago efectivo o transferencia. ` +
          `NUNCA digas "no sé" ni "no tengo información". NUNCA inventes productos, precios, tallas ni colores. ` +
          `Si piden algo que no está, ofrece uno de estos productos reales: ${muestra}. Responde solo texto plano.`,
      },
    ]
    for (const h of hist) {
      messages.push({ role: 'user', content: h.entrada })
      messages.push({ role: 'assistant', content: h.respuesta })
    }
    messages.push({ role: 'user', content: msg })
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.2, max_tokens: 150, messages }),
      signal: ctrl.signal,
    })
    if (!r.ok) return null
    const j = await r.json()
    const txt = String(j?.choices?.[0]?.message?.content || '').trim()
    return txt && !txt.startsWith('{') ? txt : null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

// ============ MINI AGENTE ============
async function miniAgente(tel: string, msg: string, st: Estado, disp: Producto[], hist: Conv[]): Promise<string> {
  const n = norm(msg)

  if (esAsesor(msg)) {
    st.paso = 'asesor'
    await saveState(st)
    return `Te paso con asesor 🙋‍♂️ Soy ${AGENTE} y dejo tu chat marcado para atención humana. ¡Gracias! 💛`
  }

  if (!disp.length) {
    return `¡Hola! 👋 Soy *${AGENTE}* de TodoEnUno SV 💛\nEstoy actualizando el catálogo en este momento. ¿Querés que te pase con un asesor?\n👉 Responde: asesor`
  }

  // ---- Recolección de datos del pedido ----
  if (st.paso === 'recolectando' && st.last_sku) {
    if (n === 'reintentar' && st.nombre_cliente && st.direccion && st.metodo_pago) {
      // Continúa al guardado usando el estado ya persistido.
    } else if (esCancelar(msg) || esListar(msg)) {
      st.paso = 'info'
      await saveState(st)
      if (esListar(msg)) return `¡Mirá lo que tenemos! ✨\n\n${listar(disp)}\n\nEscribime el nombre del que te guste 😊`
      return `Sin problema 😊 Si querés ver algo más, escribí: catalogo`
    }
    recolectar(st, msg)
    if (st.nombre_cliente && st.direccion && st.metodo_pago) {
      const prod = disp.find((p) => p.sku === st.last_sku)
      if (!prod) {
        st.paso = 'info'
        st.last_sku = null
        st.last_nombre = null
        await saveState(st)
        return `Ese artículo cambió de disponibilidad y no quiero registrarte algo incorrecto 😕 Escribí *catálogo* para elegir otro producto 💛`
      }
      const nombreProd = prod.nombre_completo
      const total = prod.precioNum
      const { error } = await supabase.from('whatsapp_orders').insert({
        telefono: tel,
        nombre: st.nombre_cliente,
        telefono_cliente: tel,
        direccion: st.direccion,
        items: [{ sku: st.last_sku, nombre: nombreProd, qty: 1, precio: total, talla: prod?.talla || null, color: prod?.color || null }],
        total,
        estado: 'nuevo',
        metodo_pago: st.metodo_pago,
      })
      if (error) {
        console.error('order insert', error.message)
        await saveState(st)
        return `Casi lo tenemos, pero hubo un problema guardando tu pedido 😕 Tus datos siguen guardados. Escribí *reintentar* y lo intento de nuevo, o *asesor* para ayudarte.`
      }
      st.paso = 'confirmado'
      await saveState(st)
      return `✅ *PEDIDO CONFIRMADO* 🎉\n\n🛍 ${nombreProd}${prod?.talla ? ` - Talla ${prod.talla}` : ''}${prod?.color ? ` - ${prod.color}` : ''}\n💰 Total: *${fmtPrecio(total)}*\n👤 ${st.nombre_cliente}\n📍 ${st.direccion}\n💳 ${st.metodo_pago}\n\n🚚 *Envío GRATIS 24-72h*\n¡Gracias! Soy ${AGENTE} 💛`
    }
    await saveState(st)
    return `¡Perfecto! Soy ${AGENTE} 😊 Solo me falta:\n\n${faltantes(st)}`
  }

  if (st.paso === 'confirmado' && (esPedir(msg) || n === 'lo quiero' || n === 'lo_quiero')) {
    return `Tu pedido anterior ya quedó registrado ✅💛 Si querés hacer otro, escribí *catálogo* y elegimos el siguiente producto.`
  }

  if (esSaludo(msg)) {
    return `¡Hola! 👋 Soy *${AGENTE}* de TodoEnUno SV 💛\nTenemos *${disp.length}* productos disponibles en el catálogo 🛍️\n\n¿Qué te gustaría ver?\n👉 Responde: catálogo\n👉 Responde: asesor`
  }

  if (esTallaColor(msg)) {
    const f = buscarPorTallaColor(msg, disp)
    if (f.length) {
      const lista = f
        .map((p) => `• *${p.nombre_completo}* - Talla ${p.talla || 'única'} - ${p.color || 'varios'} - ${fmtPrecio(p.precioNum)}`)
        .join('\n')
      return `¡Sí! Encontré en esa talla/color ✨\n\n${lista}\n\nDecime cuál te gusta 😊`
    }
  }

  if (esComoPedir(msg)) {
    if (st.last_sku) {
      st.paso = 'recolectando'
      await saveState(st)
      return `¡Muy fácil! Soy ${AGENTE} 😊 Solo necesito:\n\n${faltantes(st)}\n\nY listo, envío GRATIS 24-72h 🚚`
    }
    return `¡Fácil! Soy ${AGENTE} 😊 Elegí un producto, escribe *Lo quiero* y te pido nombre, dirección y forma de pago. Envío GRATIS 🚚\n\nEscribí: catalogo`
  }

  if (esPedir(msg) || n === 'lo quiero' || n === 'lo_quiero') {
    const prodMsg = buscarProducto(msg, disp) || productoDeUltimaRespuesta(hist, disp)
    if (prodMsg) {
      st.last_sku = prodMsg.sku
      st.last_nombre = prodMsg.nombre_completo
    }
    if (st.last_sku && disp.some(p => p.sku === st.last_sku)) {
      const elegido = disp.find(p => p.sku === st.last_sku)!
      st.last_nombre = elegido.nombre_completo
      st.paso = 'recolectando'
      await saveState(st)
      return `¡Excelente elección! 🎉 Te ayudo con *${st.last_nombre}*.\n\n${faltantes(st)}`
    }
    // Si se perdió el estado no inventar el producto ni caer en una respuesta genérica.
    st.paso = 'info'
    await saveState(st)
    return `¡Con gusto! 😊 Para no equivocarme, escribime el nombre del producto que querés comprar o toca *Ver catálogo*. Así te preparo el pedido correcto 💛`
  }

  if (esListar(msg)) {
    return `¡Mirá lo que tenemos! ✨ Todo disponible 😊\n\n${listar(disp)}\n\nEscribime el nombre del que te guste, con talla y color si aplica 😊`
  }

  const prod = buscarProducto(msg, disp)
  if (prod) {
    st.last_sku = prod.sku
    st.last_nombre = prod.nombre_completo
    st.paso = 'info'
    await saveState(st)
    return fichaProducto(prod)
  }

  const muestra = distintos(disp, 5).map((p) => `${p.nombre_completo} ${fmtPrecio(p.precioNum)}`).join('; ')
  const ia = await openaiFallback(msg, hist, muestra)
  if (ia) return ia
  return `¡Te ayudo con gusto! 😊 Puedo darte precio y detalles, mostrarte el catálogo o ayudarte a comprar. Escribí *catálogo* o mandame el nombre del producto 💛`
}

// ============ BUFFER ANTI-SPAM ============
async function unirMensajes(tel: string, raw: string): Promise<string | null> {
  try {
    const { error: insError } = await supabase.from('whatsapp_buffer').insert({ telefono: tel, mensaje: raw })
    if (insError) {
      console.error('buffer insert', insError.message)
      return raw
    }
    await sleep(BUFFER_MS)
    // Un solo invocation reclama y borra el lote; las concurrentes que lleguen después ven lote vacío.
    const { data, error } = await supabase
      .from('whatsapp_buffer')
      .delete()
      .eq('telefono', tel)
      .select('mensaje,created_at')
    if (error) {
      console.error('buffer claim', error.message)
      return raw
    }
    const rows = ((data as any[]) || []).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    if (!rows.length) return null
    return rows.map(row => String(row.mensaje || '').trim()).filter(Boolean).join(' | ') || raw
  } catch (e) {
    console.error('buffer', e)
    return raw
  }
}
// ============ WEBHOOK ============
const vistos = new Set<string>()

export async function POST(req: NextRequest) {
  try {
    if (!SB_KEY || !EVO_URL || !EVO_KEY) {
      console.error('Webhook config missing', { supabaseKey: !!SB_KEY, evolutionUrl: !!EVO_URL, evolutionKey: !!EVO_KEY })
      return NextResponse.json({ ok: false, error: 'Webhook configuration missing' }, { status: 503 })
    }
    const body = await req.json().catch(() => ({}))
    const ev = String(body?.event || '').toLowerCase().replace(/_/g, '.')
    if (ev && ev.indexOf('messages.upsert') === -1) return NextResponse.json({ ok: true })

    const data = Array.isArray(body?.data) ? body.data[0] : body?.data || {}
    const key = data?.key || {}
    if (key.fromMe) return NextResponse.json({ ok: true })

    const jid: string = key.remoteJid || ''
    if (!jid || jid.indexOf('@g.us') !== -1 || jid.indexOf('status@broadcast') !== -1) return NextResponse.json({ ok: true })

    if (key.id) {
      if (vistos.has(key.id)) return NextResponse.json({ ok: true })
      vistos.add(key.id)
      if (vistos.size > 500) vistos.clear()
    }

    let m = data?.message || {}
    // Evolution puede envolver mensajes de texto en ephemeral/view-once.
    for (let depth = 0; depth < 3; depth++) {
      if (m?.ephemeralMessage?.message) m = m.ephemeralMessage.message
      else if (m?.viewOnceMessage?.message) m = m.viewOnceMessage.message
      else if (m?.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message
      else break
    }
    const raw = String(
      m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.buttonsResponseMessage?.selectedDisplayText ||
        m.buttonsResponseMessage?.selectedButtonId ||
        m.templateButtonReplyMessage?.selectedDisplayText ||
        m.templateButtonReplyMessage?.selectedId ||
        m.interactiveResponseMessage?.body?.text ||
        m.listResponseMessage?.singleSelectReply?.selectedRowId ||
        ''
    ).trim()
    if (!raw) return NextResponse.json({ ok: true })

    const alt: string = key.senderPn || key.remoteJidAlt || key.participantPn || ''
    const number = jid.indexOf('@lid') !== -1 ? (alt ? cleanNumber(alt) : jid) : cleanNumber(jid)
    const tel = getKey(number)
    if (!tel || tel.length < 8 || !number || number === jid) {
      console.warn('Webhook ignored: could not resolve sender number', { jid, hasAlt: !!alt })
      return NextResponse.json({ ok: true })
    }

    const unido = await unirMensajes(tel, raw)
    if (unido === null) return NextResponse.json({ ok: true })

    const [st, disp, hist] = await Promise.all([getState(tel), getDisponibles(), getHistory(tel)])
    const texto = await miniAgente(tel, unido, st, disp, hist)
    const botones = botonesPara(unido, texto)

    await sendWhatsApp(number, texto, botones)
    await saveConv(tel, unido, texto)
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('webhook error', e)
    return NextResponse.json({ ok: true })
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, service: 'todoenuno-whatsapp-salesbot', instance: EVO_INSTANCE })
}
