import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })

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
  const next = { ...current, ...patch, telefono }
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
      const i = invMap.get(p.sku)
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
        body: JSON.stringify({
          number,
          text,
        }),
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
    buttonId: b.toLowerCase().replace(/\s+/g, '_').slice(0, 30),
    buttonText: { displayText: b },
    type: 1,
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
          title: text.slice(0, 60),
          description: text,
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
    (msg.length > 15 && /\d/.test(msg))
  ) {
    return msg.trim()
  }
  return null
}

function detectarPago(msg: string): string | null {
  const lower = norm(msg)
  if (lower.includes('efectivo') || lower.includes('cash')) return 'efectivo'
  if (lower.includes('transferencia') || lower.includes('banco') || lower.includes('deposito'))
    return 'transferencia'
  return null
}

async function miniAgente(
  msgRaw: string,
  telefono: string,
  st: any,
  disponibles: any[]
): Promise<{ respuesta: string; buttons?: string[]; newState?: Record<string, any> }> {
  const msg = msgRaw.trim()
  const msgN = norm(msg)

  // Buffer already handled outside; here pure intent

  // Handoff humano
  if (
    msgN.includes('asesor') ||
    msgN.includes('humano') ||
    msgN.includes('persona') ||
    msgN.includes('hablar con') ||
    msgN === 'asesor'
  ) {
    return {
      respuesta:
        'Perfecto, te paso con un asesor humano 👨‍💼\nEn breve te contactan. ¡Gracias por preferirnos! ✨',
      newState: { paso: 'humano' },
    }
  }

  // Saludo
  if (
    /^(hola|buenas|buen dia|buenas tardes|buenas noches|hey|ola|hi|hello)\b/.test(msgN) ||
    msgN === 'hola' ||
    msgN.length < 3
  ) {
    const count = disponibles.length
    return {
      respuesta: `¡Hola! 👋 Soy *Lili* de TodoEnUno SV 🇸🇻\nTenemos *${count}* productos disponibles listos para vos.\n¿Qué te gustaría hacer?`,
      buttons: ['Ver catálogo', 'Asesor'],
      newState: { paso: 'saludo' },
    }
  }

  // Listar / catálogo
  if (
    msgN.includes('catalogo') ||
    msgN.includes('ver catalogo') ||
    msgN.includes('que tienen') ||
    msgN.includes('qué tienen') ||
    msgN.includes('productos') ||
    msgN.includes('sobre que tienes') ||
    msgN.includes('sobre qué tienes') ||
    msgN.includes('info') ||
    msgN.includes('lista') ||
    msgN === 'ver_catalogo' ||
    msgN === 'catalogo'
  ) {
    const lista = disponibles.slice(0, 7)
    if (!lista.length) {
      return {
        respuesta: 'Por el momento estamos actualizando el inventario. Escribime en un rato ✨',
        buttons: ['Asesor'],
      }
    }
    const body = lista
      .map((p) => `• *${p.nombre_completo}* - $${p.precioNum.toFixed(2)}`)
      .join('\n')
    return {
      respuesta: `🛍️ *Catálogo disponible* (${disponibles.length} items)\n\n${body}\n\nDecime el nombre del que te interese o escribí *lo quiero* ✨`,
      buttons: ['Ver más', 'Asesor'],
      newState: { paso: 'listar' },
    }
  }

  // Buscar producto específico
  const matches = disponibles.filter((p) => {
    const n = norm(p.nombre_completo)
    return n.includes(msgN) || msgN.split(' ').every((w) => w.length < 3 || n.includes(w))
  })

  // Si parece búsqueda de producto
  if (
    matches.length > 0 ||
    msgN.includes('precio') ||
    msgN.includes('cuanto') ||
    msgN.includes('cuánto') ||
    msgN.includes('tiene') ||
    msgN.includes('hay')
  ) {
    let prods = matches
    if (!prods.length) {
      // fuzzy: tomar los más cercanos por palabras
      const words = msgN.split(' ').filter((w) => w.length > 2)
      prods = disponibles
        .map((p) => {
          const n = norm(p.nombre_completo)
          const score = words.reduce((s, w) => s + (n.includes(w) ? 1 : 0), 0)
          return { p, score }
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((x) => x.p)
    }

    if (prods.length === 1) {
      const p = prods[0]
      return {
        respuesta: formatProducto(p),
        buttons: ['✅ Lo quiero', '🛍️ Ver más', '❓ Duda'],
        newState: {
          paso: 'info',
          last_sku: p.sku,
          last_nombre: p.nombre_completo,
        },
      }
    }
    if (prods.length > 1) {
      const body = prods
        .slice(0, 5)
        .map((p) => `• *${p.nombre_completo}* - $${p.precioNum.toFixed(2)}`)
        .join('\n')
      return {
        respuesta: `Encontré esto parecido:\n\n${body}\n\nDecime el nombre exacto o escribí *lo quiero* del que te guste ✨`,
        buttons: ['Ver catálogo', 'Asesor'],
        newState: { paso: 'listar' },
      }
    }
    // no match
    const sugeridos = disponibles.slice(0, 5)
    const body = sugeridos
      .map((p) => `• *${p.nombre_completo}* - $${p.precioNum.toFixed(2)}`)
      .join('\n')
    return {
      respuesta: `No tengo exactamente eso 😅 pero mirá lo que sí tenemos:\n\n${body}\n\n¿Cuál te llama la atención?`,
      buttons: ['Ver catálogo', 'Asesor'],
      newState: { paso: 'listar' },
    }
  }

  // Lo quiero / pedir
  if (
    msgN.includes('lo quiero') ||
    msgN.includes('lo pido') ||
    msgN.includes('mandeme') ||
    msgN.includes('mándeme') ||
    msgN.includes('quiero uno') ||
    msgN.includes('como lo pido') ||
    msgN.includes('cómo lo pido') ||
    msgN.includes('hacer pedido') ||
    msgN === 'lo_quiero' ||
    msgN === '✅_lo_quiero'
  ) {
    const sku = st.last_sku
    const nombreProd = st.last_nombre
    if (!sku) {
      return {
        respuesta:
          '¡Claro! Primero elegí un producto del catálogo 🛍️\nEscribí *catálogo* o el nombre del producto que te interese.',
        buttons: ['Ver catálogo', 'Asesor'],
        newState: { paso: 'listar' },
      }
    }

    // Recolección de datos
    let nombre = st.nombre_cliente
    let direccion = st.direccion
    let pago = st.metodo_pago

    const posibleNombre = detectarNombre(msg)
    const posibleDir = detectarDireccion(msg)
    const posiblePago = detectarPago(msg)

    if (posibleNombre && !nombre) nombre = posibleNombre
    if (posibleDir && !direccion) direccion = posibleDir
    if (posiblePago && !pago) pago = posiblePago

    // Si el mensaje actual es solo el dato
    if (!nombre && posibleNombre) nombre = posibleNombre
    if (!direccion && posibleDir) direccion = posibleDir
    if (!pago && posiblePago) pago = posiblePago

    const faltan: string[] = []
    if (!nombre) faltan.push('nombre')
    if (!direccion) faltan.push('direccion')
    if (!pago) faltan.push('pago')

    if (faltan.length === 0) {
      // Confirmar pedido
      const prod = disponibles.find((p) => p.sku === sku) || {
        nombre_completo: nombreProd,
        precioNum: 0,
      }
      const total = prod.precioNum
      const items = [
        {
          sku,
          nombre: prod.nombre_completo || nombreProd,
          precio: total,
          qty: 1,
        },
      ]

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
        respuesta: `✅ *PEDIDO CONFIRMADO* 🎉\n\n🛍️ ${prod.nombre_completo || nombreProd}\n💰 Total: *$${total.toFixed(2)}*\n👤 ${nombre}\n📍 ${direccion}\n💳 Pago: ${pago}\n\n🚚 *Envío GRATIS* 24-72h\n¡Gracias por tu compra! Cualquier duda estoy aquí ✨`,
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

    // Pedir lo que falta
    let pregunta = 'Para confirmar tu pedido necesito:\n'
    if (!nombre) pregunta += '\n📝 *Nombre completo:*'
    if (!direccion) pregunta += '\n📍 *Dirección:* colonia, municipio, depto'
    if (!pago) pregunta += '\n💳 *Pago:* efectivo o transferencia'
    pregunta += '\n\nEscribime los datos que faltan ✨'

    return {
      respuesta: pregunta,
      newState: {
        paso: 'pedir_datos',
        nombre_cliente: nombre,
        direccion,
        metodo_pago: pago,
        last_sku: sku,
        last_nombre: nombreProd,
      },
    }
  }

  // Si estamos en pedir_datos, intentar capturar
  if (st.paso === 'pedir_datos' || st.paso === 'info') {
    let nombre = st.nombre_cliente
    let direccion = st.direccion
    let pago = st.metodo_pago

    const posibleNombre = detectarNombre(msg)
    const posibleDir = detectarDireccion(msg)
    const posiblePago = detectarPago(msg)

    if (posibleNombre) nombre = posibleNombre
    if (posibleDir) direccion = posibleDir
    if (posiblePago) pago = posiblePago

    // Si no detectó nada estructurado, asumir que es el dato que falta
    if (!nombre && !posibleDir && !posiblePago && msg.length > 3 && msg.split(' ').length <= 4) {
      nombre = msg.trim()
    } else if (!direccion && msg.length > 10) {
      direccion = msg.trim()
    }

    const faltan: string[] = []
    if (!nombre) faltan.push('nombre')
    if (!direccion) faltan.push('direccion')
    if (!pago) faltan.push('pago')

    if (faltan.length === 0 && st.last_sku) {
      const prod = disponibles.find((p) => p.sku === st.last_sku) || {
        nombre_completo: st.last_nombre,
        precioNum: 0,
      }
      const total = prod.precioNum
      const items = [
        {
          sku: st.last_sku,
          nombre: prod.nombre_completo || st.last_nombre,
          precio: total,
          qty: 1,
        },
      ]

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
        respuesta: `✅ *PEDIDO CONFIRMADO* 🎉\n\n🛍️ ${prod.nombre_completo || st.last_nombre}\n💰 Total: *$${total.toFixed(2)}*\n👤 ${nombre}\n📍 ${direccion}\n💳 Pago: ${pago}\n\n🚚 *Envío GRATIS* 24-72h\n¡Gracias por tu compra! Cualquier duda estoy aquí ✨`,
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
      newState: {
        paso: 'pedir_datos',
        nombre_cliente: nombre,
        direccion,
        metodo_pago: pago,
      },
    }
  }

  // Solo eso? / objeciones
  if (
    msgN.includes('solo eso') ||
    msgN.includes('nada mas') ||
    msgN.includes('nada más') ||
    msgN.includes('es todo')
  ) {
    const lista = disponibles.slice(0, 5)
    const body = lista
      .map((p) => `• *${p.nombre_completo}* - $${p.precioNum.toFixed(2)}`)
      .join('\n')
    return {
      respuesta: `¡Claro que no! Tenemos mucho más 🔥\n\n${body}\n\n¿Cuál te gusta?`,
      buttons: ['Ver catálogo', 'Asesor'],
    }
  }

  // Fallback con OpenAI para casos raros
  const historial = await getHistorial(telefono)
  const historialText = historial
    .map((h) => `Cliente: ${h.entrada}\nLili: ${h.respuesta}`)
    .join('\n')

  const system = `Sos Lili, vendedora salvadoreña de TodoEnUno SV. Amable, corta, usás "vos", emojis, nunca párrafos largos. Nunca digas "no sé" ni "no tengo información". Si no encontrás producto, ofrecé el más parecido real de la lista. Nunca inventés tallas/colores. Nunca muestres JSON. Temperatura baja.

Productos disponibles reales (usa SOLO estos):
${disponibles
  .slice(0, 40)
  .map((p) => `- ${p.nombre_completo} | $${p.precioNum} | ${p.estadoLabel} | sku:${p.sku}`)
  .join('\n')}

Estado actual del cliente: ${JSON.stringify({
    nombre: st.nombre_cliente,
    direccion: st.direccion,
    pago: st.metodo_pago,
    last_sku: st.last_sku,
    last_nombre: st.last_nombre,
    paso: st.paso,
  })}

Si el cliente quiere comprar, usá last_sku. Si pregunta por producto, buscá en la lista. Respuesta SOLO texto plano bonito para WhatsApp, máximo 4-5 líneas.`

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 350,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `Historial reciente:\n${historialText}\n\nMensaje actual del cliente: ${msg}`,
        },
      ],
    })
    const respuesta =
      completion.choices[0]?.message?.content?.trim() ||
      '¡Decime qué producto te interesa y te ayudo al toque! ✨'
    return {
      respuesta,
      buttons: ['Ver catálogo', 'Asesor'],
    }
  } catch {
    return {
      respuesta:
        '¡Estoy aquí! Escribí *catálogo* para ver productos o el nombre de lo que buscás ✨',
      buttons: ['Ver catálogo', 'Asesor'],
    }
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    // Evolution webhook payload
    const data = body?.data || body
    const key = data?.key || body?.key
    const remoteJid = key?.remoteJid || data?.remoteJid || ''
    if (!remoteJid || remoteJid.includes('@g.us') || key?.fromMe) {
      return NextResponse.json({ ok: true, ignored: true })
    }

    const number = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '')
    const telefono = getKey(remoteJid)

    // Extraer texto raw
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

    // Anti-spam buffer
    await supabase.from('whatsapp_buffer').insert({
      telefono,
      mensaje: raw,
      created_at: new Date().toISOString(),
    })

    // Esperar 3.5s para juntar mensajes
    await new Promise((r) => setTimeout(r, 3500))

    const { data: buffered } = await supabase
      .from('whatsapp_buffer')
      .select('mensaje, created_at')
      .eq('telefono', telefono)
      .order('created_at', { ascending: true })

    if (!buffered?.length) {
      return NextResponse.json({ ok: true, no_buffer: true })
    }

    // Solo procesar si somos el último (evitar race)
    const mensajes = buffered.map((b) => b.mensaje).join(' | ')
    await supabase.from('whatsapp_buffer').delete().eq('telefono', telefono)

    const st = await getState(telefono)
    const disponibles = await getDisponibles()

    const result = await miniAgente(mensajes, telefono, st, disponibles)

    if (result.newState) {
      await saveState(telefono, result.newState)
    }

    await sendWhatsApp(number, result.respuesta, result.buttons)
    await saveConversation(telefono, mensajes, result.respuesta)

    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error('webhook error', err)
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 200 })
  }
}

export async function GET() {
  return NextResponse.json({ status: 'Evolution webhook live', instance: EVOLUTION_INSTANCE })
}
