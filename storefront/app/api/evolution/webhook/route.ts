import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

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
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-6-luna'
const OPENAI_ANALYSIS_TIMEOUT_MS = 5000

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
type AnalisisTurno = {
  intent: 'greeting' | 'catalog' | 'product_question' | 'product_choice' | 'purchase' | 'provide_order_data' | 'cancel' | 'human' | 'how_to_order' | 'other'
  sku: string
  nombre_cliente: string
  direccion: string
  metodo_pago: '' | 'efectivo' | 'transferencia'
  respuesta_breve: string
}
const ANALISIS_VACIO: AnalisisTurno = {
  intent: 'other', sku: '', nombre_cliente: '', direccion: '', metodo_pago: '', respuesta_breve: '',
}

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
    .limit(12)
  return ((data as Conv[]) || []).reverse()
}

// ============ BLOQUEO POR CLIENTE (Supabase/Postgres) ============
// Requiere ejecutar la migración SQL incluida con este archivo.
async function adquirirBloqueoCliente(telefono: string, token: string): Promise<boolean> {
  const fin = Date.now() + 14000
  do {
    const { data, error } = await supabase.rpc('claim_whatsapp_processing_lock', {
      p_telefono: telefono,
      p_token: token,
      p_ttl_seconds: 90,
    })
    if (error) {
      console.error('claim whatsapp lock', error.message)
      return false
    }
    if (data === true) return true
    await sleep(250)
  } while (Date.now() < fin)
  return false
}
async function liberarBloqueoCliente(telefono: string, token: string) {
  const { error } = await supabase.rpc('release_whatsapp_processing_lock', {
    p_telefono: telefono,
    p_token: token,
  })
  if (error) console.error('release whatsapp lock', error.message)
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
  // Recupera la última ficha individual sin depender del texto exacto de la pregunta de venta.
  // Se exige encabezado al principio para no confundir un catálogo con una selección.
  for (let i = hist.length - 1; i >= Math.max(0, hist.length - 4); i--) {
    const last = String(hist[i]?.respuesta || '').trim()
    const match = last.match(/^🛍️\s*\*([^*]+)\*/i)
    if (!match?.[1]) continue
    const nombre = norm(match[1])
    const found = disp.find(p => norm(p.nombre_completo) === nombre)
    if (found) return found
  }
  return null
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

function recolectar(st: Estado, msg: string, analisis: AnalisisTurno = ANALISIS_VACIO) {
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
  // Use structured extraction only for values explicitly present in the current message.
  if (!st.nombre_cliente && analisis.nombre_cliente && !esDireccion(analisis.nombre_cliente)) {
    const nom = detectaNombre(analisis.nombre_cliente) || analisis.nombre_cliente.trim()
    if (nom && nom.length <= 100) st.nombre_cliente = nom
  }
  if (!st.direccion && analisis.direccion && analisis.direccion.trim().length >= 5) {
    st.direccion = analisis.direccion.trim().slice(0, 500)
  }
  if (analisis.metodo_pago) st.metodo_pago = analisis.metodo_pago
  if (!algo && !st.direccion && msg.trim().length > 12 && !esPedir(msg)) st.direccion = msg.trim()
}

// ============ AGENTE DE INTERPRETACIÓN DE TURNO ============
// Un único análisis estructurado interpreta el lenguaje natural. Las transiciones de compra
// y el registro de pedidos siguen siendo deterministas en miniAgente.
function sanitizarParaModelo(value: string, st: Estado): string {
  let out = String(value || '')
  for (const privateValue of [st.nombre_cliente, st.direccion]) {
    if (privateValue && privateValue.trim().length >= 3) {
      const escaped = privateValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      out = out.replace(new RegExp(escaped, 'gi'), '[DATO_CLIENTE]')
    }
  }
  return out.slice(0, 1200)
}

async function analizarTurno(msg: string, st: Estado, disp: Producto[], hist: Conv[]): Promise<AnalisisTurno> {
  const fallback = { ...ANALISIS_VACIO }
  if (!OPENAI_KEY) return fallback
  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), OPENAI_ANALYSIS_TIMEOUT_MS)
  try {
    const catalogo = disp.slice(0, 120).map(p => ({ sku: p.sku, nombre: p.nombre_completo, precio: p.precioNum, talla: p.talla, color: p.color }))
    const historial = hist.slice(-12).map(h => ({
      cliente: sanitizarParaModelo(h.entrada, st),
      asistente: sanitizarParaModelo(h.respuesta, st),
    }))
    const contexto = {
      mensaje_actual: msg,
      estado_compra: st.paso || 'inicio',
      producto_actual: st.last_sku ? { sku: st.last_sku, nombre: st.last_nombre || '' } : null,
      datos_pedido_ya_guardados: {
        nombre: Boolean(st.nombre_cliente), direccion: Boolean(st.direccion), pago: Boolean(st.metodo_pago),
      },
      historial_reciente: historial,
      catalogo_real: catalogo,
    }
    const instructions = `Eres un microagente de interpretación para el vendedor de WhatsApp ${AGENTE} de TodoEnUno SV. No conversas con el cliente: analiza su intención en contexto y devuelve solo el objeto exigido por el esquema. El cliente puede escribir con errores, abreviaturas, salvadoreñismos, mensajes partidos, pronombres (ese/esa/lo), sin tildes o con muchas formas equivalentes. Lee el historial reciente y el estado de compra antes de clasificar.\n` +
      `intents: greeting=saludo; catalog=pide catálogo/más productos; product_question=pregunta información/precio de producto; product_choice=menciona o selecciona producto; purchase=quiere comprar/encargar/recibir el producto o confirma que sí lo quiere; provide_order_data=da nombre, dirección o forma de pago; cancel=desiste; human=pide asesor/persona; how_to_order=pregunta cómo comprar; other=resto.\n` +
      `Cuando el estado sea esperando_producto_para_comprar, un producto mencionado debe interpretarse como el producto que quiere comprar y NO debes volver a preguntar si lo quiere. También revisa el historial: si la persona ya dijo que quiere comprar y el asistente le pidió identificar/escribir el producto, su siguiente nombre de producto continúa esa compra aunque el estado guardado diga info/inicio. Cuando la última ficha individual o el estado identifique un producto, mensajes como "sí", "dale", "va", "me lo llevo", "mandamelo", "quiero ese", "hágale", "de una", "lo quiero" pueden confirmar compra. Si está recolectando datos, interpreta el mensaje como datos del pedido cuando corresponda; nunca confundas el nombre de un producto con el nombre de la persona.\n` +
      `sku debe ser únicamente un SKU literal del catálogo proporcionado; usa cadena vacía si no puedes determinarlo. No inventes SKUs ni datos personales. nombre_cliente, direccion, metodo_pago solo deben contener información explícita del mensaje_actual, no la deduzcas de mensajes antiguos; si no aparece en el mensaje actual, usa cadena vacía. metodo_pago solo puede ser efectivo o transferencia; acepta equivalencias como "contra entrega", "cuando llegue" y "le pago al recibir" para efectivo, y "depósito" o "por banco" para transferencia.\n` +
      `respuesta_breve solo se usa para preguntas que no resuelve la lógica de catálogo/compra. Español salvadoreño natural, breve y amable. No inventes productos, precios, disponibilidad, políticas, ni afirmes que un pedido ya está registrado. El envío es gratis; los productos DISPONIBLE son de entrega inmediata y TEST pueden requerir 3–5 días según el estado dado por la aplicación.`
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        instructions,
        input: JSON.stringify(contexto),
        max_output_tokens: 300,
        store: false,
        text: {
          format: {
            type: 'json_schema', name: 'analisis_turno', strict: true,
            schema: {
              type: 'object', additionalProperties: false,
              properties: {
                intent: { type: 'string', enum: ['greeting','catalog','product_question','product_choice','purchase','provide_order_data','cancel','human','how_to_order','other'] },
                sku: { type: 'string' },
                nombre_cliente: { type: 'string' },
                direccion: { type: 'string' },
                metodo_pago: { type: 'string', enum: ['', 'efectivo', 'transferencia'] },
                respuesta_breve: { type: 'string' },
              },
              required: ['intent','sku','nombre_cliente','direccion','metodo_pago','respuesta_breve'],
            },
          },
        },
      }),
      signal: ctrl.signal,
    })
    if (!r.ok) {
      console.error('analizarTurno OpenAI', r.status, (await r.text().catch(() => '')).slice(0, 400))
      return fallback
    }
    const j = await r.json()
    const output = (j?.output || []).flatMap((item: any) => item?.content || []).find((c: any) => c?.type === 'output_text')?.text
    if (!output) return fallback
    const parsed = JSON.parse(String(output)) as AnalisisTurno
    const validSkus = new Set(disp.map(p => p.sku))
    if (parsed.sku && !validSkus.has(parsed.sku)) parsed.sku = ''
    if (!['', 'efectivo', 'transferencia'].includes(parsed.metodo_pago)) parsed.metodo_pago = ''
    if (!['greeting','catalog','product_question','product_choice','purchase','provide_order_data','cancel','human','how_to_order','other'].includes(parsed.intent)) parsed.intent = 'other'
    parsed.nombre_cliente = String(parsed.nombre_cliente || '').trim().slice(0, 100)
    parsed.direccion = String(parsed.direccion || '').trim().slice(0, 500)
    parsed.respuesta_breve = String(parsed.respuesta_breve || '').trim().slice(0, 700)
    return parsed
  } catch (e) {
    console.error('analizarTurno error', e instanceof Error ? e.message : e)
    return fallback
  } finally {
    clearTimeout(timeout)
  }
}

function hayCompraPendienteEnHistorial(hist: Conv[]): boolean {
  const ultima = hist[hist.length - 1]
  if (ultima && (esCancelar(ultima.entrada) || /sin problema.*cuando queras comprar|cancelamos|pedido cancelado/.test(norm(ultima.respuesta)))) return false
  const compra = /\b(lo quiero|lo llevo|me lo llevo|mandame|mandeme|me lo manda|quiero comprar|quiero uno|apartar|pedido|encargar|de una|haganlo|hagale)\b/
  const pideProducto = /(escribime.*producto|nombre del producto|cual producto|que producto.*comprar|producto que queres comprar|identificar cual producto|no hace falta volver a confirmar)/
  return hist.slice(-4).some(h => compra.test(norm(h.entrada)) && pideProducto.test(norm(h.respuesta))) ||
    hist.slice(-2).some(h => /ya entendi que queres comprar|seguimos directamente con tus datos/.test(norm(h.respuesta)))
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

  const analisis = await analizarTurno(msg, st, disp, hist)
  const quiereComprar = esPedir(msg) || analisis.intent === 'purchase'
  if (analisis.intent === 'human' && !esAsesor(msg)) {
    st.paso = 'asesor'
    await saveState(st)
    return `Te paso con asesor 🙋‍♂️ Soy ${AGENTE} y dejo tu chat marcado para atención humana. ¡Gracias! 💛`
  }

  // Recupera la intención pendiente tanto desde el estado persistido como desde los últimos intercambios
  // (esto repara chats que quedaron en 'info' por la versión anterior del webhook).
  if (st.paso === 'info' && hayCompraPendienteEnHistorial(hist)) {
    st.paso = 'esperando_producto_para_comprar'
    await saveState(st)
  }
  if (st.paso === 'esperando_producto_para_comprar') {
    if (esCancelar(msg) || analisis.intent === 'cancel') {
      st.paso = 'info'
      await saveState(st)
      return `Sin problema 😊 Cuando querás comprar algo, escribime y seguimos.`
    }
    if (esListar(msg) || analisis.intent === 'catalog') {
      await saveState(st)
      return `¡Claro! Estas son algunas opciones ✨\n\n${listar(disp)}\n\nDecime cuál querés comprar y seguimos con tu pedido 😊`
    }
    const skuPendiente = analisis.sku && disp.some(p => p.sku === analisis.sku) ? analisis.sku : ''
    const prodPendiente = (skuPendiente ? disp.find(p => p.sku === skuPendiente) : null) || buscarProducto(msg, disp)
    if (prodPendiente) {
      st.last_sku = prodPendiente.sku
      st.last_nombre = prodPendiente.nombre_completo
      st.paso = 'recolectando'
      await saveState(st)
      return `¡Perfecto! 🎉 Ya tengo el producto: *${st.last_nombre}*. Seguimos con tu compra 😊\n\n${faltantes(st)}`
    }
    if (analisis.intent === 'other' && analisis.respuesta_breve) {
      return `${analisis.respuesta_breve}\n\nY seguimos con tu compra: solo necesito que me digás qué producto querés 😊`
    }
    return `¡Sí, te ayudo a comprarlo! 😊 Escribime el nombre del producto o elegilo del catálogo y seguimos directamente con tus datos; no hace falta volver a confirmar que lo querés 💛\n\n${listar(disp, 5)}`
  }

  // ---- Recolección de datos del pedido ----
  if (st.paso === 'recolectando' && st.last_sku) {
    if (analisis.sku && analisis.sku !== st.last_sku && ['purchase', 'product_choice'].includes(analisis.intent)) {
      const nuevo = disp.find(p => p.sku === analisis.sku)
      if (nuevo) {
        st.last_sku = nuevo.sku
        st.last_nombre = nuevo.nombre_completo
        await saveState(st)
        return `Perfecto, cambiamos tu elección a *${nuevo.nombre_completo}* 😊\n\n${faltantes(st)}`
      }
    }
    if (n === 'reintentar' && st.nombre_cliente && st.direccion && st.metodo_pago) {
      // Continúa al guardado usando el estado ya persistido.
    } else if (esCancelar(msg) || analisis.intent === 'cancel' || esListar(msg) || analisis.intent === 'catalog') {
      st.paso = 'info'
      await saveState(st)
      if (esListar(msg) || analisis.intent === 'catalog') return `¡Mirá lo que tenemos! ✨\n\n${listar(disp)}\n\nEscribime el nombre del que te guste 😊`
      return `Sin problema 😊 Si querés ver algo más, escribí: catalogo`
    }
    recolectar(st, msg, analisis)
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

  if (st.paso === 'confirmado' && quiereComprar && (!analisis.sku || analisis.sku === st.last_sku) && !buscarProducto(msg, disp)) {
    return `Tu pedido anterior ya quedó registrado ✅💛 Si querés hacer otro, decime qué producto nuevo querés comprar o escribí *catálogo*.`
  }
  if (st.paso === 'confirmado' && (analisis.intent === 'product_choice' || (analisis.sku && analisis.sku !== st.last_sku))) {
    st.paso = 'info'
  }

  if (esSaludo(msg) || analisis.intent === 'greeting') {
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

  if (esComoPedir(msg) || analisis.intent === 'how_to_order') {
    if (st.last_sku) {
      st.paso = 'recolectando'
      await saveState(st)
      return `¡Muy fácil! Soy ${AGENTE} 😊 Solo necesito:\n\n${faltantes(st)}\n\nY listo, envío GRATIS 24-72h 🚚`
    }
    return `¡Fácil! Soy ${AGENTE} 😊 Elegí un producto, escribe *Lo quiero* y te pido nombre, dirección y forma de pago. Envío GRATIS 🚚\n\nEscribí: catalogo`
  }

  if (quiereComprar || n === 'lo quiero' || n === 'lo_quiero') {
    const productoAnalizado = analisis.sku ? disp.find(p => p.sku === analisis.sku) || null : null
    const prodMsg = productoAnalizado || buscarProducto(msg, disp) || (st.last_sku ? disp.find(p => p.sku === st.last_sku) || null : null) || productoDeUltimaRespuesta(hist, disp)
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
    st.paso = 'esperando_producto_para_comprar'
    await saveState(st)
    return `¡Con gusto! 😊 Ya entendí que querés comprar. Solo necesito identificar cuál producto: escribime su nombre o elegilo del catálogo y seguimos directamente con tus datos, sin volver a preguntarte si lo querés 💛\n\n${listar(disp, 5)}`
  }

  if (esListar(msg) || analisis.intent === 'catalog') {
    return `¡Mirá lo que tenemos! ✨ Todo disponible 😊\n\n${listar(disp)}\n\nEscribime el nombre del que te guste, con talla y color si aplica 😊`
  }

  const productoAnalizado = analisis.sku && ['product_question', 'product_choice'].includes(analisis.intent)
    ? disp.find(p => p.sku === analisis.sku) || null
    : null
  const prod = productoAnalizado || buscarProducto(msg, disp)
  if (prod) {
    st.last_sku = prod.sku
    st.last_nombre = prod.nombre_completo
    st.paso = 'info'
    await saveState(st)
    return fichaProducto(prod)
  }

  if (analisis.respuesta_breve && analisis.intent === 'other') return analisis.respuesta_breve
  return `¡Te ayudo con gusto! 😊 Puedo darte precio y detalles, mostrarte el catálogo o ayudarte a comprar. Escribí *catálogo* o mandame el nombre del producto 💛`
}

// ============ AGENTE DE COHERENCIA ============
// Revisa el texto final contra el estado real. Es una defensa determinista contra bucles de compra.
function protegerCoherencia(respuesta: string, st: Estado): string {
  const r = norm(respuesta)
  if (st.paso === 'recolectando' && /(que producto queres|nombre del producto|te lo aparto|responde lo quiero|si lo queres)/.test(r)) {
    return `Ya tengo tu producto: *${st.last_nombre || 'el artículo elegido'}* 😊 No necesitás volver a elegirlo. Para completar la compra solo me falta:\n\n${faltantes(st)}`
  }
  if (st.paso === 'esperando_producto_para_comprar' && /(te lo aparto|responde lo quiero|confirmame si lo queres)/.test(r)) {
    return `Ya entendí que querés comprar 😊 Solo necesito que me digás el nombre del producto. Después seguimos directamente con los datos del pedido.`
  }
  if (st.paso === 'confirmado' && /(escribime lo quiero|te lo aparto|confirmame si lo queres)/.test(r)) {
    return `Tu pedido ya está registrado ✅💛 Si querés comprar otro artículo, decime cuál producto nuevo buscás.`
  }
  return respuesta
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

    // Serializa por teléfono a través de todas las instancias serverless, no solo por memoria local.
    const lockToken = randomUUID()
    const lockAdquirido = await adquirirBloqueoCliente(tel, lockToken)
    if (!lockAdquirido) {
      // No perder el mensaje si otra ejecución mantuvo el bloqueo demasiado tiempo.
      const { error } = await supabase.from('whatsapp_buffer').insert({ telefono: tel, mensaje: unido })
      if (error) console.error('buffer requeue after lock timeout', error.message)
      return NextResponse.json({ ok: false, error: 'conversation_busy' }, { status: 503 })
    }

    try {
      // Mover el dedupe local dentro del bloqueo evita que dos ejecuciones calientes lean/escriban el mismo estado a la vez.
      if (key.id) {
        if (vistos.has(key.id)) return NextResponse.json({ ok: true })
        vistos.add(key.id)
        if (vistos.size > 500) vistos.clear()
      }
      const [st, disp, hist] = await Promise.all([getState(tel), getDisponibles(), getHistory(tel)])
      const respuestaAgente = await miniAgente(tel, unido, st, disp, hist)
      const texto = protegerCoherencia(respuestaAgente, st)
      const botones = botonesPara(unido, texto)

      await sendWhatsApp(number, texto, botones)
      await saveConv(tel, unido, texto)
      return NextResponse.json({ ok: true })
    } finally {
      await liberarBloqueoCliente(tel, lockToken)
    }
  } catch (e: any) {
    console.error('webhook error', e)
    return NextResponse.json({ ok: true })
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, service: 'todoenuno-whatsapp-salesbot', instance: EVO_INSTANCE })
}
