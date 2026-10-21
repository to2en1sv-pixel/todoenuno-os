import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL!
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'eee'
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY!

function norm(s: string | null | undefined): string {
  if (!s) return ''
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getKey(jid: string): string {
  const digits = (jid || '').replace(/\D/g, '')
  return digits.slice(-11)
}

async function getState(telefono: string) {
  const { data } = await supabase
    .from('whatsapp_state')
    .select('*')
    .eq('telefono', telefono)
    .maybeSingle()
  return data || {
    telefono,
    nombre_cliente: null,
    direccion: null,
    metodo_pago: null,
    paso: 'inicio',
    last_nombre: null,
    last_sku: null,
  }
}

async function saveState(telefono: string, patch: Record<string, any>) {
  const current = await getState(telefono)
  const next = { ...current, ...patch, telefono, updated_at: new Date().toISOString() }
  await supabase.from('whatsapp_state').upsert(next, { onConflict: 'telefono' })
  return next
}

async function getDisponibles() {
  const { data: prods } = await supabase
    .from('productos_variantes')
    .select('sku, nombre_completo, precio, talla, color, image_url')

  if (!prods?.length) return []

  const skus = prods.map((p) => p.sku)
  const { data: inv } = await supabase
    .from('inventory_cache')
    .select('sku, qty, state')
    .in('sku', skus)

  const invMap = new Map((inv || []).map((i) => [i.sku, i]))

  return prods
    .map((p) => {
      const i = invMap.get(p.sku) as any
      const state = i?.state || 'NO_DISPONIBLE'
      const qty = i?.qty ?? 0
      let disponible = false
      let estadoLabel = '❌ No disponible'
      if (state === 'DISPONIBLE' && qty > 0) {
        disponible = true
        estadoLabel = '✅ Entrega inmediata'
      } else if (state === 'TEST') {
        disponible = true
        estadoLabel = '✨ Disponible bajo pedido 3-5 días'
      }
      return {
        ...p,
        qty,
        state,
        disponible,
        estadoLabel,
        precioNum: Number(p.precio) || 0,
      }
    })
    .filter((p) => p.disponible)
}

function formatProducto(p: any) {
  const lines = [
    `🛍️ *${p.nombre_completo}*`,
    `💰 Precio: *$${p.precioNum.toFixed(2)}*`,
  ]
  if (p.talla) lines.push(`📏 Talla: ${p.talla}`)
  if (p.color) lines.push(`🎨 Color: ${p.color}`)
  lines.push(`📦 Estado: ${p.estadoLabel}`)
  return lines.join('\n')
}

async function sendText(number: string, text: string) {
  try {
    const res = await fetch(
      `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: EVOLUTION_API_KEY,
        },
        body: JSON.stringify({ number, text }),
      }
    )
    return res.ok
  } catch {
    return false
  }
}

async function sendButtons(
  number: string,
  text: string,
  buttons: string[],
  footer = 'TodoEnUno SV | Envío Gratis 🚚'
) {
  const btns = buttons.slice(0, 3).map((b) => ({
    displayText: b,
  }))
  try {
    const res = await fetch(
      `${EVOLUTION_API_URL}/message/sendButtons/${EVOLUTION_INSTANCE}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: EVOLUTION_API_KEY,
        },
        body: JSON.stringify({
          number,
          text,
          footer,
          buttons: btns,
        }),
      }
    )
    if (res.ok) return true
  } catch {}
  return sendText(number, text + '\n\n' + buttons.map((b) => `• ${b}`).join('\n'))
}

async function sendWhatsApp(number: string, text: string, buttons?: string[]) {
  if (buttons && buttons.length > 0) {
    return sendButtons(number, text, buttons)
  }
  return sendText(number, text)
}

async function saveConversation(telefono: string, entrada: string, respuesta: string) {
  await supabase.from('whatsapp_conversations').insert({
    telefono,
    entrada,
    respuesta,
    created_at: new Date().toISOString(),
  })
}

async function getHistorial(telefono: string) {
  const { data } = await supabase
    .from('whatsapp_conversations')
    .select('entrada, respuesta')
    .eq('telefono', telefono)
    .order('created_at', { ascending: false })
    .limit(6)
  return (data || []).reverse()
}

function detectarNombre(msg: string): string | null {
  const t = msg.trim()
  const words = t.split(/\s+/).filter(Boolean)
  if (words.length >= 2 && words.length <= 4 && !/\d/.test(t) && t.length < 50) {
    const lower = norm(t)
    if (
      !lower.includes('colonia') &&
      !lower.includes('calle') &&
      !lower.includes('san salvador') &&
      !lower.includes('efectivo') &&
      !lower.includes('transferencia') &&
      !lower.includes('quiero') &&
      !lower.includes('catalogo')
    ) {
      return t
    }
  }
  return null
}

function detectarDireccion(msg: string): string | null {
  const lower = norm(msg)
  if (
    lower.includes('colonia') ||
    lower.includes('calle') ||
    lower.includes('avenida') ||
    lower.includes('san salvador') ||
    lower.includes('escalon') ||
    lower.includes('municipio') ||
    lower.includes('depto') ||
    lower.includes('departamento') ||
    lower.includes('santa tecla') ||
    lower.includes('merliot') ||
    lower.includes('la libertad')
  ) {
    return msg.trim()
  }
  return null
}

function detectarPago(msg: string): string | null {
  const lower = norm(msg)
  if (lower.includes('efectivo')) return 'efectivo'
  if (lower.includes('transferencia')) return 'transferencia'
  if (lower.includes('chivo') || lower.includes('bitcoin')) return 'transferencia'
  return null
}

async function miniAgente(msg: string, telefono: string, st: any, disponibles: any[]) {
  const msgN = norm(msg)
  const originalMsg = msg.trim()

  // Buscar producto mencionado
  let prod: any = null
  if (st.last_sku) {
    prod = disponibles.find((p) => p.sku === st.last_sku)
  }
  if (!prod) {
    const words = msgN.split(' ').filter((w) => w.length > 3)
    for (const w of words) {
      const found = disponibles.find((p) => norm(p.nombre_completo).includes(w))
      if (found) { prod = found; break; }
    }
  }
  if (!prod) {
    prod = disponibles.find((p) => msgN.includes(norm(p.nombre_completo).slice(0, 15)))
  }
  if (!prod && disponibles.length > 0) prod = disponibles[0]

  // Saludo
  if (['hola', 'buenas', 'hey', 'ola', 'buenos dias', 'buenas tardes', 'buenas noches'].some(v => msgN === v || msgN.startsWith(v + ' '))) {
    const ejemplo = disponibles[0]
    return {
      respuesta: `🛍️ *¡Hola! Bienvenido a TodoEnUno* 👋\n\nTenemos *${disponibles.length} productos* disponibles, por ejemplo:\n• *${ejemplo?.nombre_completo || 'PORTA BEBES'}* a *$${ejemplo?.precioNum?.toFixed(2) || '15.00'}*\n\n¿En qué te ayudo hoy? 😊`,
      buttons: ['🛍️ Ver catálogo', '💬 Asesor'],
      newState: prod ? { last_sku: prod.sku, last_nombre: prod.nombre_completo } : {},
    }
  }

  // Listar
  if (msgN.includes('catalogo') || msgN.includes('que tienen') || msgN.includes('que venden') || msgN.includes('ver catalogo') || msgN.includes('productos')) {
    const lista = disponibles.slice(0, 7).map((p) => `• *${p.nombre_completo}* - $${p.precioNum.toFixed(2)}`).join('\n')
    return {
      respuesta: `🛍️ *Tenemos ${disponibles.length} productos* 🥳\n\n${lista}\n\nDecime cuál te gusta y te doy detalles 😊`,
      buttons: ['Ver más', 'Asesor'],
      newState: {},
    }
  }

  // Info de producto específico
  const esInfo = msgN.includes('info') || msgN.includes('precio') || msgN.includes('cuanto') || msgN.includes('talla') || msgN.includes('color') || prod
  if (esInfo && prod && !msgN.includes('quiero') && !msgN.includes('pedir') && !msgN.includes('comprar') && !msgN.includes('ordenar')) {
    return {
      respuesta: `${formatProducto(prod)}\n\n¿Te lo aparto? Decime "lo quiero" 🚚`,
      buttons: ['✅ Lo quiero', '🛍️ Ver más', '❓ Duda'],
      newState: { last_sku: prod.sku, last_nombre: prod.nombre_completo },
    }
  }

  // Flujo PEDIR - detectar datos
  if (msgN.includes('quiero') || msgN.includes('pedir') || msgN.includes('comprar') || msgN.includes('ordenar') || msgN.includes('lo quiero') || msgN.includes('mandeme') || st.paso === 'pedir_datos' || st.nombre_cliente) {
    let nombre = st.nombre_cliente
    let direccion = st.direccion
    let pago = st.metodo_pago

    // Intentar extraer del mensaje actual
    const maybeNombre = detectarNombre(originalMsg)
    const maybeDir = detectarDireccion(originalMsg)
    const maybePago = detectarPago(originalMsg)

    if (maybeNombre && !nombre) nombre = maybeNombre
    if (maybeDir) direccion = originalMsg
    if (maybePago) pago = maybePago

    // Si mensaje es solo nombre y estamos pidiendo
    if (!direccion && !pago && maybeNombre && originalMsg.split('|').length === 1) {
      // ya lo tomamos como nombre
    }

    const okN = !!nombre, okD = !!direccion, okP = !!pago
    const total = prod?.precioNum || Number(st.last_nombre ? disponibles.find(d=>d.sku===st.last_sku)?.precioNum : 15) || 15

    if (okN && okD && okP) {
      const items = [{ nombre: prod?.nombre_completo || st.last_nombre || 'Producto', sku: prod?.sku || st.last_sku, talla: prod?.talla, color: prod?.color }]
      await supabase.from('whatsapp_orders').insert({
        telefono,
        nombre,
        telefono_cliente: telefono,
        direccion,
        items,
        total,
        estado: 'confirmado',
        metodo_pago: pago,
      })
      return {
        respuesta: `✅ *PEDIDO CONFIRMADO* 🎉\n\n🛍️ ${prod?.nombre_completo || st.last_nombre}\n💰 Total: *$${total.toFixed(2)}*\n👤 ${nombre}\n📍 ${direccion}\n💳 Pago: ${pago}\n\n🚚 *Envío GRATIS* 24-72h\n¡Gracias por tu compra! Cualquier duda estoy aquí ✨`,
        newState: {
          paso: 'confirmado',
          nombre_cliente: nombre,
          direccion,
          metodo_pago: pago,
          last_sku: null,
          last_nombre: null,
        },
      }
    }

    let pregunta = '¡Súper! Me falta:\n'
    if (!nombre) pregunta += '\n📝 *Nombre completo:*'
    if (!direccion) pregunta += '\n📍 *Dirección:* colonia, municipio, depto'
    if (!pago) pregunta += '\n💳 *Pago:* efectivo o transferencia'
    pregunta += '\n\nMandame eso y lo dejamos listo ✨'

    return {
      respuesta: pregunta,
      buttons: ['✅ Confirmar', '✏️ Cambiar datos'],
      newState: {
        paso: 'pedir_datos',
        nombre_cliente: nombre,
        direccion,
        metodo_pago: pago,
        last_sku: prod?.sku || st.last_sku,
        last_nombre: prod?.nombre_completo || st.last_nombre,
      },
    }
  }

  // Solo eso? objeciones
  if (msgN.includes('solo eso') || msgN.includes('nada mas') || msgN.includes('es todo')) {
    const lista = disponibles.slice(0, 5).map((p) => `• *${p.nombre_completo}* - $${p.precioNum.toFixed(2)}`).join('\n')
    return {
      respuesta: `¡Claro que no! Tenemos mucho más 🔥\n\n${lista}\n\n¿Cuál te gusta?`,
      buttons: ['Ver catálogo', 'Asesor'],
      newState: {},
    }
  }

  // Fallback con OpenAI usando fetch (no SDK) - 0 dependencias extra
  const historial = await getHistorial(telefono)
  const historialText = historial.map((h) => `Cliente: ${h.entrada}\nLili: ${h.respuesta}`).join('\n')

  const system = `Sos LILI, vendedora salvadoreña de TodoEnUno SV. Amable, corta, usás "vos", emojis, nunca párrafos largos. Nunca digas "no sé" ni "no tengo información". Si no encontrás producto, ofrecé el más parecido real de la lista. Nunca inventés tallas/colores. Nunca muestres JSON. 

Productos disponibles reales (usa SOLO estos):
${disponibles.slice(0, 40).map((p) => `- ${p.nombre_completo} | $${p.precioNum} | ${p.estadoLabel} | sku:${p.sku}`).join('\n')}

Estado actual: ${JSON.stringify({ nombre: st.nombre_cliente, direccion: st.direccion, pago: st.metodo_pago, last_sku: st.last_sku, last_nombre: st.last_nombre, paso: st.paso })}

Si el cliente quiere comprar, usá last_sku. Si pregunta por producto, buscá en la lista. Respuesta SOLO texto plano bonito para WhatsApp, máximo 4-5 líneas.`

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        max_tokens: 350,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Historial reciente:\n${historialText}\n\nMensaje actual del cliente: ${msg}` },
        ],
      }),
    })
    const j: any = await r.json()
    const respuesta = j.choices?.[0]?.message?.content?.trim() || '¡Decime qué producto te interesa y te ayudo al toque! ✨'
    return { respuesta, buttons: ['Ver catálogo', 'Asesor'] }
  } catch {
    return {
      respuesta: '¡Estoy aquí! Escribí *catálogo* para ver productos o el nombre de lo que buscás ✨',
      buttons: ['Ver catálogo', 'Asesor'],
    }
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const data = body?.data || body
    const key = data?.key || body?.key
    const remoteJid = key?.remoteJid || data?.remoteJid || ''
    if (!remoteJid || remoteJid.includes('@g.us') || key?.fromMe) {
      return NextResponse.json({ ok: true, ignored: true })
    }

    const number = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '')
    const telefono = getKey(remoteJid)

    const msgContent = data?.message || body?.message || {}
    const raw =
      msgContent.conversation ||
      msgContent.extendedTextMessage?.text ||
      msgContent.imageMessage?.caption ||
      msgContent.buttonsResponseMessage?.selectedButtonId ||
      msgContent.buttonsResponseMessage?.selectedDisplayText ||
      msgContent.listResponseMessage?.singleSelectReply?.selectedRowId ||
      msgContent.templateButtonReplyMessage?.selectedId ||
      msgContent.templateButtonReplyMessage?.selectedDisplayText ||
      ''

    if (!raw || typeof raw !== 'string') {
      return NextResponse.json({ ok: true, empty: true })
    }

    await supabase.from('whatsapp_buffer').insert({
      telefono,
      mensaje: raw,
      created_at: new Date().toISOString(),
    })

    await new Promise((r) => setTimeout(r, 3500))

    const { data: buffered } = await supabase
      .from('whatsapp_buffer')
      .select('mensaje, created_at')
      .eq('telefono', telefono)
      .order('created_at', { ascending: true })

    if (!buffered?.length) {
      return NextResponse.json({ ok: true, no_buffer: true })
    }

    const mensajes = buffered.map((b) => b.mensaje).join(' | ')
    await supabase.from('whatsapp_buffer').delete().eq('telefono', telefono)

    const st = await getState(telefono)
    const disponibles = await getDisponibles()
    const result = await miniAgente(mensajes, telefono, st, disponibles)

    if (result.newState) {
      await saveState(telefono, result.newState)
    }

    await sendWhatsApp(number, result.respuesta, (result as any).buttons)
    await saveConversation(telefono, mensajes, result.respuesta)

    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error('webhook error', err)
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 200 })
  }
}

export async function GET() {
  retur
