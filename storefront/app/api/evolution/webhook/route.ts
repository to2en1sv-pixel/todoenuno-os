import Redis from 'ioredis';
const redis = new Redis(process.env.REDIS_URL!); // redis://redis:6379 en docker
// DEBOUNCE 8s con tu redis existente - arregla image_98f9a5.png
async function debounceBuffer(k: string, raw: string) {
  await redis.lpush(`wa:${k}`, raw);
  await redis.expire(`wa:${k}`, 8);
  await new Promise(r => setTimeout(r, 8000)); // espera 8s como claude-whatsapp-template
  const msgs = await redis.lrange(`wa:${k}`, 0, -1);
  await redis.del(`wa:${k}`);
  return msgs.reverse().join(' | '); // "juan maariano | efectivo | san salvador"
}
async function saveState(supa: any, k: string, u: any) {
  const e = await getState(supa, k);
  const m = { ...(e || {}), ...u, telefono: k };
  await supa.from('whatsapp_state').delete().eq('telefono', k);
  await supa.from('whatsapp_state').insert(m);
}

// ==================== MINI AGENTE DE IA - SOLO DETECTA "QUIERO PEDIRLO" Y VARIANTES ====================
async function miniAgenteIntencion(mensaje: string): Promise<{ intencion: 'PEDIR' | 'INFO' | 'LISTAR' | 'SALUDO', confianza: number, razon: string }> {
  const prompt = `
Eres clasificador de intención para tienda to2en1.app El Salvador.
Mensaje cliente: "${mensaje}"

Clasifica SOLO en:
- PEDIR: quiere comprar/pedir/ordenar el producto. Variaciones:
  "quiero pedirlo, quiero uno, quiero ese, mandeme uno, mándame uno, envieme uno, envíame uno, me manda uno, me lo manda, lo quiero, lo compro, quiero ordenarlo, pido uno, me lo envía, quiero comprarlo, tráigame uno, quiero el porta bebes, me interesa pedirlo, como lo pido, como hago para pedirlo, donde lo pido"
- INFO: quiere información, precio, detalles, fotos, que es, para que sirve
- LISTAR: quiere ver catálogo, que productos tienen, que más tienen
- SALUDO: hola, buenas, hey

Responde SOLO JSON: {"intencion":"PEDIR|INFO|LISTAR|SALUDO","confianza":0.0-1.0,"razon":"breve"}

Ejemplos:
"mandeme uno" => {"intencion":"PEDIR","confianza":0.99,"razon":"variacion directa de pedir"}
"quiero uno" => {"intencion":"PEDIR","confianza":0.98,"razon":"quiere comprar"}
"me lo manda a san salvador" => {"intencion":"PEDIR","confianza":0.95,"razon":"pide envío = intención compra"}
"hola" => {"intencion":"SALUDO","confianza":1.0,"razon":"saludo"}
"que precio tiene" => {"intencion":"INFO","confianza":0.95,"razon":"pregunta precio"}
`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0, messages: [{ role: 'user', content: prompt }] })
    });
    const j = await r.json();
    const txt = j.choices?.[0]?.message?.content?.replace(/```json/g, '').replace(/```/g, '').trim() || '{}';
    return JSON.parse(txt);
  } catch {
    // Fallback heurístico si falla la IA
    const n = norm(mensaje);
    const pedirKeywords = ['quiero', 'mandeme', 'mandame', 'envieme', 'enviame', 'pido', 'ordeno', 'compro', 'traigame', 'me lo', 'me manda', 'quiero uno', 'mandeme uno', 'envieme uno', 'lo quiero', 'quiero ese', 'pedirlo', 'comprarlo'];
    const esPedir = pedirKeywords.some(k => n.includes(k));
    return { intencion: esPedir ? 'PEDIR' : 'INFO', confianza: 0.6, razon: 'fallback heuristic' };
  }
}
// ==================== FIN MINI AGENTE ====================

export async function GET() { return Response.json({ v: 'v33-mini-agente-pedir' }); }

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const d = body.data || body;
    if (d.key?.fromMe) return Response.json({ ok: true });
    const jid = d.key?.remoteJid || '';
    const raw = (d.message?.conversation || d.message?.extendedTextMessage?.text || '').trim();
    if (!raw || !jid) return Response.json({ ok: true });
    const k = getKey(jid);
    const supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

    // BUFFER 3s para tus 3 mensajes separados
    await supa.from('whatsapp_buffer').insert({ telefono: k, mensaje: raw });
    await new Promise(r => setTimeout(r, 3000));
    const { data: buf } = await supa.from('whatsapp_buffer').select('mensaje').eq('telefono', k).order('created_at', { ascending: true });
    const msg = (buf?.map((m: any) => m.mensaje).join(' | ') || raw).trim();
    await supa.from('whatsapp_buffer').delete().eq('telefono', k);

    // MINI AGENTE: detecta intención ANTES del agente grande
    const clasif = await miniAgenteIntencion(msg);
    console.log('MINI AGENTE:', clasif);

    const { data: vars } = await supa.from('productos_variantes').select('*').limit(500);
    let st = await getState(supa, k);
    if (!st) st = { telefono: k };

    const prod = vars?.find((v: any) => norm(v.nombre_completo).includes('porta bebes')) || vars?.[0];
    const link = `https://to2en1.app/shop/${slug(prod?.nombre_completo || 'porta-bebes')}`;
    const tallaTxt = prod?.talla ? `Talla ${prod.talla}` : '';
    const colorTxt = prod?.color ? `Color ${prod.color}` : '';

    let sys = '';
    if (clasif.intencion === 'PEDIR') {
      sys = `Eres Todd de to2en1.app. Cliente QUIERE PEDIR ${prod?.nombre_completo} (confianza ${clasif.confianza} - ${clasif.razon}). Producto: $${prod?.precio} ${tallaTxt} ${colorTxt} Link: ${link}
ESTADO: Nombre=${st.nombre_cliente || 'FALTA'} | Dir=${st.direccion || 'FALTA'} | Pago=${st.metodo_pago || 'FALTA'}
Pide SOLO lo que dice FALTA con: "Para coordinar tu pedido necesito estos datos:||📝 Nombre completo:|📍 Dirección:|💳 Método de pago:"
JSON: {"accion":"respuesta_simple o confirmar_pedido","sku":"${prod?.nombre_completo}","nombre_cliente":null,"direccion":null,"metodo_pago":null,"respuesta":""}`;
    } else if (clasif.intencion === 'INFO') {
      sys = `Eres Todd de to2en1.app. Cliente quiere INFO de ${prod?.nombre_completo} $${prod?.precio} ${tallaTxt} ${colorTxt} Link: ${link}. Responde con info, NO pidas datos de pedido. JSON: {"accion":"respuesta_simple","respuesta":"El Porta Bebés tiene un precio de $${prod?.precio}. ${tallaTxt} ${colorTxt}. Más detalles en ${link}"}`;
    } else if (clasif.intencion === 'LISTAR') {
      const lista = vars?.slice(0, 5).map((v: any) => `${v.nombre_completo} $${v.precio}`).join(', ');
      sys = `Eres Todd. Cliente quiere ver catálogo. Productos: ${lista}. Link catálogo: https://to2en1.app/shop Responde lista corta. JSON: {"accion":"respuesta_simple","respuesta":"Aquí tienes algunos productos: ${lista} || Para ver más: https://to2en1.app/shop"}`;
    } else {
      sys = `Eres Todd de to2en1.app. Cliente saluda. Responde: "¡Hola! Buenas noches. ¿En qué puedo ayudarte hoy? Tenemos Porta Bebés $15. Más en ${link}" JSON: {"accion":"respuesta_simple","respuesta":""}`;
    }

    const hist = await supa.from('whatsapp_conversations').select('entrada,respuesta').eq('telefono', k).order('created_at', { ascending: true }).limit(8);
    const messages: any[] = [{ role: 'system', content: sys }];
    if (hist.data) for (const h of hist.data) { messages.push({ role: 'user', content: h.entrada }); messages.push({ role: 'assistant', content: h.respuesta }); }
    messages.push({ role: 'user', content: msg });

    const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.2, messages }) });
    const j = await r.json();
    let p: any = {};
    try { p = JSON.parse(j.choices?.[0]?.message?.content?.replace(/```json/g, '').replace(/```/g, '').trim() || '{}'); } catch { p = { respuesta: j.choices?.[0]?.message?.content || '' }; }

    const n = norm(msg);
    if (clasif.intencion === 'PEDIR') {
      if (!p.nombre_cliente && !st.nombre_cliente && msg.split(' ').length >= 2 && !n.includes('colonia') && !n.includes('efectivo') && n.length < 40) p.nombre_cliente = msg.split('|')[0].trim();
      if (n.includes('colonia') || n.includes('escalon')) p.direccion = msg;
      if (n.includes('efectivo')) p.metodo_pago = 'efectivo';
      if (n.includes('transferencia')) p.metodo_pago = 'transferencia';
      if (!p.nombre_cliente) p.nombre_cliente = st.nombre_cliente;
      if (!p.direccion) p.direccion = st.direccion;
      if (!p.metodo_pago) p.metodo_pago = st.metodo_pago;
      if (!p.sku) p.sku = st.last_nombre || prod?.nombre_completo;
    }

    const okN = p.nombre_cliente?.length > 2, okD = p.direccion?.length > 5, okP = p.metodo_pago?.length > 0;
    let resp = p.respuesta || '';

    if (okN && okD && okP && clasif.intencion === 'PEDIR') {
      await supa.from('whatsapp_orders').insert({ telefono: k, nombre: p.nombre_cliente, telefono_cliente: k, direccion: p.direccion, items: [{ nombre: p.sku, talla: prod?.talla, color: prod?.color }], total: prod?.precio || 15, estado: 'nuevo', metodo_pago: p.metodo_pago });
      await saveState(supa, k, { paso: 'confirmado', nombre_cliente: p.nombre_cliente, direccion: p.direccion, metodo_pago: p.metodo_pago, last_nombre: p.sku });
      resp = `✅ PEDIDO CONFIRMADO\n🛍️ ${p.sku}${prod?.talla ? `\n📏 Talla: ${prod.talla}` : ''}${prod?.color ? `\n🎨 Color: ${prod.color}` : ''}\n👤 ${p.nombre_cliente}\n📍 ${p.direccion}\n💳 ${p.metodo_pago}\n🔗 ${link}\n\n🚚 Envio GRATIS 24-72h`;
    } else {
      if (clasif.intencion === 'PEDIR' && (!okN || !okD || !okP)) {
        await saveState(supa, k, { nombre_cliente: p.nombre_cliente, direccion: p.direccion, metodo_pago: p.metodo_pago, last_nombre: p.sku });
        if (!resp.includes('Nombre completo')) resp = `Para coordinar tu pedido necesito estos datos:||📝 Nombre completo:|📍 Dirección: (colonia, municipio, departamento, calle y punto de referencia)|💳 Método de pago: (efectivo o transferencia)`;
      }
    }

    await supa.from('whatsapp_conversations').insert({ telefono: k, entrada: msg, respuesta: resp, intencion: clasif.intencion, confianza: clasif.confianza });
    await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`, { method: 'POST', headers: { 'apikey': process.env.EVOLUTION_API_KEY!, 'Content-Type': 'application/json' }, body: JSON.stringify({ number: jid, text: resp.replace(/\|/g, '\n') }) });
    return Response.json({ ok: true, intencion: clasif });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
