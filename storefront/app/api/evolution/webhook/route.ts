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
