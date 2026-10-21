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
  const pedirVars = ['quiero pedirlo','quiero uno','quiero ese','mandeme uno','mandame uno','envieme uno','enviame uno','me manda uno','me lo manda','lo quiero','lo compro','quiero comprarlo','como lo pido','como lo ordeno','como hago para pedirlo','como lo solicito','me interesa pedirlo','quiero ordenarlo','pido uno','traigame uno','como lo adquiero','me lo envia','mandemelo','enviamelo','ordenar'];
  const esPedir = pedirVars.some(v => n.includes(v));
  const esInfo = n.includes('info') || n.includes('precio') || n.includes('cuanto') || n.includes('detalles') || n.includes('talla') || n.includes('color');
  const esListar = n.includes('que productos') || n.includes('que tienen') || n.includes('catalogo') || n.includes('que venden');
  const esSaludo = ['hola','buenas','hey','buenos dias','buenas tardes','buenas noches'].some(v => n === v || n.startsWith(v+' '));
  if (esPedir) return 'PEDIR';
  if (esListar) return 'LISTAR';
  if (esInfo) return 'INFO';
  if (esSaludo) return 'SALUDO';
  return 'CHAT';
}

export async function GET() { return Response.json({ v: 'v38-disponible-fix' }); }

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const d = body.data || body;
    if (d.key?.fromMe) return Response.json({ ok: true });
    const jid = d.key?.remoteJid || '';
    const raw = (d.message?.conversation || d.message?.extendedTextMessage?.text || d.message?.imageMessage?.caption || '').trim();
    if (!raw || !jid) return Response.json({ ok: true });
    const k = getKey(jid);
    const supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

    // BUFFER Vercel con tabla (tu redis local sigue con REDIS_URL en docker)
    await supa.from('whatsapp_buffer').insert({ telefono: k, mensaje: raw });
    await new Promise(r => setTimeout(r, 3500));
    const { data: buf } = await supa.from('whatsapp_buffer').select('mensaje').eq('telefono', k).order('created_at', { ascending: true });
    const msg = (buf?.map((m: any) => m.mensaje).join(' | ') || raw).trim();
    await supa.from('whatsapp_buffer').delete().eq('telefono', k);

    const intencion = miniAgente(msg);
    
    // TRAE TODO + STOCK REAL DE TU SYNC ODOO
    const { data: vars } = await supa.from('productos_variantes').select('*').limit(500);
    const { data: stock } = await supa.from('inventory_cache').select('sku, qty, state');
    const stockMap = new Map(stock?.map((s:any)=>[s.sku, s]) || []);

    // Solo productos con stock DISPONIBLE o TEST (para no ofrecer NO_DISPONIBLE)
    const disponibles = (vars || []).filter((v:any)=>{
      const s = stockMap.get(v.sku);
      return !s || s.state === 'DISPONIBLE' || s.state === 'TEST';
    });

    let st = await getState(supa, k);
    if (!st) st = { telefono: k };

    // BUSQUEDA DINAMICA - no mas porta bebes hardcodeado
    const nMsg = norm(msg);
    let prod: any = null;
    if (st.last_sku) prod = disponibles.find((v:any)=> v.sku === st.last_sku);
    if (!prod) prod = disponibles.find((v:any)=> nMsg.includes(norm(v.nombre_completo).slice(0,15)) || norm(v.nombre_completo).includes(nMsg.split(' ').slice(0,2).join(' ')));
    if (!prod && disponibles.length) prod = disponibles[0];

    const precio = prod?.precio || 15;
    const detalleReal = [prod?.talla ? `Talla: ${prod.talla}` : null, prod?.color ? `Color: ${prod.color}` : null].filter(Boolean).join(' | ');

    let sys = '';
    if (intencion === 'PEDIR' || st.nombre_cliente) {
      sys = `Eres Todd vendedor to2en1.app El Salvador. Solo hablas de productos de tu catalogo, no de capitales ni geografia. No mandes links, no mandes JSON en la respuesta.
Producto actual: ${prod?.nombre_completo} $${precio} ${detalleReal}
ESTADO: Nombre=${st.nombre_cliente||'FALTA'} | Dir=${st.direccion||'FALTA'} | Pago=${st.metodo_pago||'FALTA'}
Si faltan datos, pide SOLO lo que dice FALTA con este formato:
Para coordinar tu pedido necesito estos datos:
📝 Nombre completo:
📍 Dirección: (colonia, municipio, departamento, calle y punto de referencia)
💳 Método de pago: (efectivo o transferencia)
Internamente responde JSON: {"accion":"respuesta_simple o confirmar_pedido","sku":"${prod?.sku}","nombre_cliente":null,"direccion":null,"metodo_pago":null,"respuesta":""}`;
    } else if (intencion === 'INFO') {
      sys = `Eres Todd. Producto: ${prod?.nombre_completo} $${precio} ${detalleReal}. No mandes links. No inventes talla. Si detalleReal vacio no menciones talla/color. Responde solo texto plano, no JSON en la respuesta visible. Internamente JSON: {"accion":"respuesta_simple","respuesta":"El ${prod?.nombre_completo} tiene un precio de $${precio}. ${detalleReal}"}`;
    } else if (intencion === 'LISTAR') {
      const lista = disponibles.slice(0, 8).map((v: any) => `${v.nombre_completo} $${v.precio}`).join(' | ');
      sys = `Cliente quiere catalogo. Productos DISPONIBLES: ${lista}. No mandes links. Responde solo texto plano listando. Internamente JSON: {"accion":"respuesta_simple","respuesta":"Productos disponibles: ${lista}"}`;
    } else {
      const ejemplo = disponibles[0]?.nombre_completo || prod?.nombre_completo || 'PORTA BEBES';
      const pEjemplo = disponibles[0]?.precio || precio;
      sys = `Cliente saluda. Responde "¡Hola! Buenas noches. ¿En qué puedo ayudarte hoy? Tenemos ${ejemplo} a $${pEjemplo} y ${disponibles.length-1} productos más." No mandes links. Solo texto plano. JSON interno: {"accion":"respuesta_simple","respuesta":""}`;
    }

    const hist = await supa.from('whatsapp_conversations').select('entrada,respuesta').eq('telefono', k).order('created_at', { ascending: true }).limit(6);
    const messages: any[] = [{ role: 'system', content: sys }];
    if (hist.data) for (const h of hist.data) { messages.push({ role: 'user', content: h.entrada }); messages.push({ role: 'assistant', content: h.respuesta }); }
    messages.push({ role: 'user', content: msg });

    const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.1, messages }) });
    const j = await r.json();
    let p: any = {};
    try { 
      const content = j.choices?.[0]?.message?.content?.replace(/```json/g, '').replace(/```/g, '').trim() || '{}';
      // Si viene con texto antes del JSON, extrae el JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      p = JSON.parse(jsonMatch ? jsonMatch[0] : content); 
    } catch { p = { respuesta: j.choices?.[0]?.message?.content || '' }; }

    const n = norm(msg);
    if (intencion === 'PEDIR' || st.nombre_cliente) {
      if (!p.nombre_cliente && !st.nombre_cliente && msg.split(' ').length >= 2 && msg.split(' ').length <= 4 && !n.includes('colonia') && !n.includes('efectivo') && n.length < 40) p.nombre_cliente = msg.split('|')[0].trim();
      if (n.includes('colonia') || n.includes('escalon') || n.includes('san salvador') || n.includes('santa tecla') || n.includes('calle')) p.direccion = msg;
      if (n.includes('efectivo')) p.metodo_pago = 'efectivo';
      if (n.includes('transferencia')) p.metodo_pago = 'transferencia';
      if (!p.nombre_cliente) p.nombre_cliente = st.nombre_cliente;
      if (!p.direccion) p.direccion = st.direccion;
      if (!p.metodo_pago) p.metodo_pago = st.metodo_pago;
      if (!p.sku) p.sku = st.last_sku || prod?.sku;
    }

    const okN = p.nombre_cliente?.length > 2, okD = p.direccion?.length > 5, okP = p.metodo_pago?.length > 0;
    let resp = p.respuesta || '';

    if (okN && okD && okP && intencion === 'PEDIR') {
      await supa.from('whatsapp_orders').insert({ 
        telefono: k, nombre: p.nombre_cliente, telefono_cliente: k, 
        direccion: p.direccion, items: [{ nombre: prod?.nombre_completo, sku: p.sku, talla: prod?.talla, color: prod?.color }], 
        total: precio, estado: 'nuevo', metodo_pago: p.metodo_pago 
      });
      await saveState(supa, k, { paso: 'confirmado', nombre_cliente: p.nombre_cliente, direccion: p.direccion, metodo_pago: p.metodo_pago, last_nombre: prod?.nombre_completo, last_sku: prod?.sku });
      resp = `✅ PEDIDO CONFIRMADO\n🛍 ${prod?.nombre_completo}${prod?.talla ? `\n📏 Talla: ${prod.talla}` : ''}${prod?.color ? `\n🎨 Color: ${prod.color}` : ''}\n👤 ${p.nombre_cliente}\n📍 ${p.direccion}\n💳 ${p.metodo_pago}\n\n🚚 Envio GRATIS 24-72h`;
    } else if (intencion === 'PEDIR' && (!okN || !okD || !okP)) {
      await saveState(supa, k, { nombre_cliente: p.nombre_cliente, direccion: p.direccion, metodo_pago: p.metodo_pago, last_nombre: prod?.nombre_completo, last_sku: prod?.sku });
      if (!resp.includes('Nombre completo')) resp = `Para coordinar tu pedido necesito estos datos:\n📝 Nombre completo:\n📍 Dirección: (colonia, municipio, departamento, calle y punto de referencia)\n💳 Método de pago: (efectivo o transferencia)`;
    } else {
      await saveState(supa, k, { last_nombre: prod?.nombre_completo, last_sku: prod?.sku });
    }

    await supa.from('whatsapp_conversations').insert({ telefono: k, entrada: msg, respuesta: resp });
    await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`, { method: 'POST', headers: { 'apikey': process.env.EVOLUTION_API_KEY!, 'Content-Type': 'application/json' }, body: JSON.stringify({ number: jid, text: resp.replace(/\|/g, '\n') }) });
    return Response.json({ ok: true, intencion, prod: prod?.sku });
  } catch (e: any) {
    console.error(e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
