import { createClient } from '@supabase/supabase-js';
export const dynamic = 'force-dynamic';

const norm = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const getKey = (jid: string) => jid.split('@')[0].replace(/[^0-9]/g, '').slice(-11);

async function getState(supa: any, k: string) {
  const { data } = await supa.from('whatsapp_state').select('*').eq('telefono', k).limit(1).maybeSingle();
  return data;
}
async function saveState(supa: any, k: string, u: any) {
  await supa.from('whatsapp_state').upsert({ telefono: k, ...u, updated_at: new Date().toISOString() }, { onConflict: 'telefono' });
}

function miniAgente(msg: string) {
  const n = norm(msg);
  if (n.includes('lo_quiero') || n.includes('lo quiero') || n.includes('confirmar pedido') || n.includes('quiero uno') || n.includes('mandeme uno') || n.includes('pido uno')) return 'PEDIR';
  if (n.includes('catalogo') || n.includes('ver mas') || n.includes('que productos') || n.includes('que tienen') || n.includes('ver catalogo')) return 'LISTAR';
  if (n.includes('precio') || n.includes('cuanto') || n.includes('info') || n.includes('talla') || n.includes('color') || n.includes('detalles')) return 'INFO';
  if (['hola','buenas','hey','ola'].some(v => n===v || n.startsWith(v+' '))) return 'SALUDO';
  return 'CHAT';
}

async function sendWhatsApp(jid: string, text: string, intencion: string) {
  const base = process.env.EVOLUTION_API_URL!;
  const instance = process.env.EVOLUTION_INSTANCE!;
  const headers = { 'apikey': process.env.EVOLUTION_API_KEY!, 'Content-Type': 'application/json' };
  let buttons: any[] = [];
  if (intencion === 'SALUDO' || intencion === 'LISTAR') {
    buttons = [{ displayText: "🛍️ Ver catálogo" }, { displayText: "💬 Asesor" }];
  } else if (intencion === 'INFO' || intencion === 'CHAT') {
    buttons = [{ displayText: "✅ Lo quiero" }, { displayText: "🛍️ Ver más" }, { displayText: "❓ Duda" }];
  } else if (intencion === 'PEDIR') {
    buttons = [{ displayText: "✅ Confirmar" }, { displayText: "✏️ Cambiar datos" }];
  }
  if (buttons.length) {
    const r = await fetch(`${base}/message/sendButtons/${instance}`, {
      method: 'POST', headers,
      body: JSON.stringify({ number: jid, text, footer: "TodoEnUno SV | Envío Gratis 🚚", buttons: buttons.slice(0,3) })
    });
    if (r.ok) return;
  }
  await fetch(`${base}/message/sendText/${instance}`, {
    method: 'POST', headers, body: JSON.stringify({ number: jid, text })
  });
}

export async function GET() { return Response.json({ v: 'v40-bonito-con-botones' }); }

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const d = body.data || body;
    if (d.key?.fromMe) return Response.json({ ok: true });
    const jid = d.key?.remoteJid || '';
    const raw = (
      d.message?.conversation ||
      d.message?.extendedTextMessage?.text ||
      d.message?.imageMessage?.caption ||
      d.message?.buttonsResponseMessage?.selectedButtonId ||
      d.message?.buttonsResponseMessage?.selectedDisplayText ||
      d.message?.listResponseMessage?.singleSelectReply?.selectedRowId || ''
    ).trim();
    if (!raw || !jid) return Response.json({ ok: true });
    const k = getKey(jid);
    const supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

    await supa.from('whatsapp_buffer').insert({ telefono: k, mensaje: raw });
    await new Promise(r => setTimeout(r, 3500));
    const { data: buf } = await supa.from('whatsapp_buffer').select('mensaje').eq('telefono', k).order('created_at', { ascending: true });
    const msg = (buf?.map((m: any) => m.mensaje).join(' | ') || raw).trim();
    await supa.from('whatsapp_buffer').delete().eq('telefono', k);

    const intencion = miniAgente(msg);
    const { data: vars } = await supa.from('productos_variantes').select('*').limit(500);
    const { data: stock } = await supa.from('inventory_cache').select('sku, qty, state');
    const stockMap = new Map(stock?.map((s: any) => [s.sku, s]) || []);
    const disponibles = (vars || []).filter((v: any) => {
      const s = stockMap.get(v.sku); return !s || s.state === 'DISPONIBLE' || s.state === 'TEST';
    });

    let st = await getState(supa, k);
    if (!st) st = { telefono: k };
    const nMsg = norm(msg);
    let prod: any = disponibles.find((v: any) => v.sku === st.last_sku) || disponibles.find((v: any) => norm(v.nombre_completo).includes(nMsg.slice(0, 15)) || nMsg.includes(norm(v.nombre_completo).split(' ')[0])) || disponibles[0];
    const precio = prod?.precio || 15;
    const qty = stockMap.get(prod?.sku)?.qty || 0;
    const estadoTxt = qty > 0 ? `✅ Disponible` : `✨ Bajo pedido (3-5 días)`;

    let sys = '';
    if (intencion === 'PEDIR' || st.nombre_cliente) {
      sys = `Eres LILI TodoEnUno SV. Solo texto bonito con emojis. Producto: ${prod?.nombre_completo} $${precio} Estado: Nombre=${st.nombre_cliente||'FALTA'} Dir=${st.direccion||'FALTA'} Pago=${st.metodo_pago||'FALTA'}. Si falta pide: 📝 Nombre completo: | 📍 Dirección: | 💳 Pago: efectivo/transferencia. Interno JSON {"accion":"respuesta_simple","sku":"${prod?.sku}","respuesta":""}`;
    } else if (intencion === 'INFO') {
      sys = `Eres LILI. Responde bonito formato:
🛍️ *${prod?.nombre_completo}*

💰 Precio: *$${precio}*
${prod?.talla ? `📏 Talla: ${prod.talla}\n` : ''}${prod?.color ? `🎨 Color: ${prod.color}\n` : ''}📦 ${estadoTxt}

¿Te lo aparto? 🚚 Interno JSON {"accion":"respuesta_simple","respuesta":""}`;
    } else if (intencion === 'LISTAR') {
      const lista = disponibles.slice(0, 7).map((v: any) => `• *${v.nombre_completo}* - $${v.precio}`).join('\n');
      sys = `Catalogo: ${lista}. Responde:
🛍️ *Tenemos ${disponibles.length} productos* 🥳

${lista}

Decime cual te gusta 😊 Interno JSON {"accion":"respuesta_simple","respuesta":""}`;
    } else {
      sys = `Saludo: Responde:
🛍️ *¡Hola! Bienvenido a TodoEnUno* 👋

Tenemos *${disponibles.length} productos* como *${disponibles[0]?.nombre_completo}* a *$${disponibles[0]?.precio}*

¿En qué te ayudo? 😊 Interno JSON {"accion":"respuesta_simple","respuesta":""}`;
    }

    const hist = await supa.from('whatsapp_conversations').select('entrada,respuesta').eq('telefono', k).order('created_at', { ascending: true }).limit(6);
    const messages: any[] = [{ role: 'system', content: sys }];
    if (hist.data) for (const h of hist.data) { messages.push({ role: 'user', content: h.entrada }); messages.push({ role: 'assistant', content: h.respuesta }); }
    messages.push({ role: 'user', content: msg });

    const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.3, messages }) });
    const j = await r.json();
    let p: any = {};
    try { const c = j.choices?.[0]?.message?.content || ''; const m = c.match(/\{[\s\S]*\}/); p = JSON.parse(m ? m[0] : c); } catch { p = { respuesta: j.choices?.[0]?.message?.content || '' }; }

    const n = norm(msg);
    if (intencion === 'PEDIR' || st.nombre_cliente) {
      if (!p.nombre_cliente && !st.nombre_cliente && msg.split(' ').length >= 2 && msg.split(' ').length <= 4 && !n.includes('colonia') && n.length < 40) p.nombre_cliente = msg.split('|')[0].trim();
      if (n.includes('colonia') || n.includes('calle') || n.includes('san salvador') || n.includes('santa tecla') || n.includes('escalon')) p.direccion = msg;
      if (n.includes('efectivo')) p.metodo_pago = 'efectivo';
      if (n.includes('transferencia')) p.metodo_pago = 'transferencia';
      if (!p.nombre_cliente) p.nombre_cliente = st.nombre_cliente;
      if (!p.direccion) p.direccion = st.direccion;
      if (!p.metodo_pago) p.metodo_pago = st.metodo_pago;
    }

    const okN = p.nombre_cliente?.length > 2, okD = p.direccion?.length > 5, okP = p.metodo_pago?.length > 0;
    let resp = p.respuesta || '';

    if (okN && okD && okP && intencion === 'PEDIR') {
      await supa.from('whatsapp_orders').insert({ telefono: k, nombre: p.nombre_cliente, telefono_cliente: k, direccion: p.direccion, items: [{ nombre: prod?.nombre_completo, sku: prod?.sku }], total: precio, estado: 'nuevo', metodo_pago: p.metodo_pago });
      await saveState(supa, k, { paso: 'confirmado', nombre_cliente: p.nombre_cliente, direccion: p.direccion, metodo_pago: p.metodo_pago, last_nombre: prod?.nombre_completo, last_sku: prod?.sku });
      resp = `✅ *PEDIDO CONFIRMADO* 🎉\n\n🛍️ ${prod?.nombre_completo}\n💰 *$${precio}*\n👤 ${p.nombre_cliente}\n📍 ${p.direccion}\n💳 ${p.metodo_pago}\n\n🚚 Envío GRATIS 24-72h. ¡Gracias! ✨`;
    } else if (intencion === 'PEDIR' && (!okN || !okD || !okP)) {
      await saveState(supa, k, { nombre_cliente: p.nombre_cliente, direccion: p.direccion, metodo_pago: p.metodo_pago, last_nombre: prod?.nombre_completo, last_sku: prod?.sku });
      if (!resp.includes('Nombre')) resp = `Para coordinar tu pedido necesito:\n\n📝 *Nombre completo:*\n📍 *Dirección:* (colonia, municipio, depto)\n💳 *Pago:* efectivo / transferencia`;
    } else {
      await saveState(supa, k, { last_nombre: prod?.nombre_completo, last_sku: prod?.sku });
    }

    await supa.from('whatsapp_conversations').insert({ telefono: k, entrada: msg, respuesta: resp });
    await sendWhatsApp(jid, resp.replace(/\|/g, '\n'), intencion);
    return Response.json({ ok: true, intencion });
  } catch (e: any) {
    console.error(e); return Response.json({ error: e.message }, { status: 500 });
  }
}
