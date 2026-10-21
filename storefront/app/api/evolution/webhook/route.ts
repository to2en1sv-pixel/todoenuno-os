import { createClient } from '@supabase/supabase-js';
export const dynamic = 'force-dynamic';

const norm = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const getKey = (jid: string) => jid.split('@')[0].replace(/[^0-9]/g,'').slice(-11);
const slugify = (s: string) => norm(s).replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

// ==================== AGENTE 0: BUFFER + DEBOUNCE (tu bot/nodes/debounce.js) - INICIO ====================
async function bufferMensajes(supa: any, k: string, raw: string) {
  const { data: ins } = await supa.from('whatsapp_buffer').insert({ telefono: k, mensaje: raw }).select('id').single();
  await new Promise(r => setTimeout(r, 3000));
  const { data: ultimo } = await supa.from('whatsapp_buffer').select('id').eq('telefono', k).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (String(ins?.id) !== String(ultimo?.id)) return null; // no es el ultimo, espera
  const { data: todos } = await supa.from('whatsapp_buffer').select('mensaje').eq('telefono', k).order('created_at', { ascending: true });
  const concat = todos?.map((m: any) => m.mensaje).join(' ') || raw;
  await supa.from('whatsapp_buffer').delete().eq('telefono', k);
  return concat;
}
// ==================== AGENTE 0: FIN ====================

// ==================== AGENTE 1: ESTADO REAL DE SUPABASE - INICIO ====================
async function getState(supa: any, k: string) {
  const { data } = await supa.from('whatsapp_state').select('*').eq('telefono', k).limit(1).maybeSingle();
  return data;
}
async function saveState(supa: any, k: string, updates: any) {
  const existing = await getState(supa, k);
  const merged = { ...(existing || {}), ...updates, telefono: k };
  await supa.from('whatsapp_state').delete().eq('telefono', k);
  await supa.from('whatsapp_state').insert(merged);
}

function detectarNuevoProducto(mensaje: string, vars: any[], lastNombre: string | null) {
  const n = norm(mensaje);
  if (n.includes('porta') && n.includes('bebe')) return vars.find((v: any) => norm(v.nombre_completo).includes('porta'));
  if (n.includes('microfono')) return vars.find((v: any) => norm(v.nombre_completo).includes('microfono'));
  return null;
}
// ==================== AGENTE 1: FIN ====================

// ==================== AGENTE 2: TODD REAL CON DATOS DE SUPABASE + to2en1.app - INICIO ====================
function buildSystemPrompt(vars: any[], state: any, nombre: string, esNuevo: boolean) {
  const hora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/El_Salvador' })).getHours();
  const saludo = hora < 12 ? 'Buenos dias!' : hora < 18 ? 'Buenas tardes!' : 'Buenas noches!';
  
  let catalogoTexto = "";
  let productoConfirmado = "";
  let linkProducto = "";

  if (state?.last_nombre && !esNuevo) {
    const prod = vars.find((v: any) => norm(v.nombre_completo).includes(norm(state.last_nombre)));
    if (prod) {
      // DATOS REALES DE SUPABASE, no hardcode
      const tallaReal = prod.talla ? `Talla: ${prod.talla}` : '';
      const colorReal = prod.color ? `Color: ${prod.color}` : '';
      const stockReal = prod.stock ? `Stock: ${prod.stock}` : '';
      linkProducto = `https://to2en1.app/shop/${slugify(prod.nombre_completo)}`;
      productoConfirmado = `PRODUCTO CONFIRMADO: ${prod.nombre_completo} | $${prod.precio || 15} ${tallaReal} ${colorReal} | Link: ${linkProducto}`;
      catalogoTexto = `${prod.sku || prod.id} | ${prod.nombre_completo} | $${prod.precio} ${tallaReal} ${colorReal}`;
    }
  } else {
    // Lista real de to2en1.app/shop
    const porta = vars.find((v: any) => norm(v.nombre_completo).includes('porta'));
    const lista = [porta, ...vars].filter(Boolean).slice(0, 15);
    catalogoTexto = lista.map((v: any) => {
      const t = v.talla ? `Talla ${v.talla}` : '';
      const c = v.color ? `Color ${v.color}` : '';
      return `${v.nombre_completo} | $${v.precio} ${t} ${c}`.trim();
    }).join(' || ');
  }

  return `Eres Todd, vendedor de to2en1.app por WhatsApp El Salvador. Envio GRATIS 24-72h.
CATALOGO REAL SUPABASE: ${catalogoTexto}
${productoConfirmado}
CLIENTE: ${nombre} SALUDO: ${saludo}
WEB: https://to2en1.app/shop

FORMATO JSON OBLIGATORIO:
{"accion":"respuesta_simple o confirmar_pedido","sku":null,"nombre_cliente":null,"direccion":null,"metodo_pago":null,"respuesta":"mensaje"}
Usa | para salto.

REGLA: ${productoConfirmado && !esNuevo ? `Producto confirmado ${state.last_nombre}. Mantenlo. Si cliente pregunta talla/color responde con datos reales de Supabase, si no tiene datos no inventes talla unica.` : 'Si cliente dice "que mas tienes" lista productos de to2en1.app con precio y link: https://to2en1.app/shop'}

REGLA DATOS: Extrae nombre, direccion, pago de mensaje aunque venga en 2 lineas. No pidas talla/color si el producto no lo tiene en Supabase.

REGLA CONFIRMACION: sku+nombre+direccion+pago => confirmar_pedido con respuesta="".
Pide: "Para coordinar tu pedido necesito estos datos:||📝 Nombre completo:|📍 Dirección: (colonia, municipio, departamento, calle y punto de referencia)|💳 Método de pago: (efectivo o transferencia)"
`;
}
// ==================== AGENTE 2: FIN ====================

function parsearRespuestaIA(raw: string, skuFallback: string) {
  let p: any;
  try { p = JSON.parse(raw.replace(/```json/g,'').replace(/```/g,'').trim()); } catch { p = { accion: 'respuesta_simple', sku: skuFallback, respuesta: raw }; }
  if (!p.sku) p.sku = skuFallback;
  const okNombre = p.nombre_cliente?.length > 2;
  const okDir = p.direccion?.length > 5;
  const okPago = p.metodo_pago?.length > 0;
  if (p.accion === 'confirmar_pedido' && (!okNombre || !okDir || !okPago)) p.accion = 'respuesta_simple';
  if (p.accion === 'respuesta_simple' && okNombre && okDir && okPago) { p.accion = 'confirmar_pedido'; p.respuesta = ""; }
  return p;
}

// ==================== AGENTE 4: LILI FINAL CON LINK to2en1.app - INICIO ====================
export async function GET() { return Response.json({ v: 'v29-poderoso-supabase-to2en1' }); }

export async function POST(req: Request) {
  try {
    const body = await req.json(); const d = body.data || body;
    if (d.key?.fromMe) return Response.json({ ok: true });
    const jid = d.key?.remoteJid || ''; const rawOriginal = (d.message?.conversation || d.message?.extendedTextMessage?.text || '').trim();
    if (!rawOriginal || !jid) return Response.json({ ok: true });
    const k = getKey(jid);
    const supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

    const mensajeConcatenado = await bufferMensajes(supa, k, rawOriginal);
    if (!mensajeConcatenado) return Response.json({ ok: true, buffered: true });

    const mensaje = mensajeConcatenado.trim();
    const nombre = d.pushName || 'Cliente';
    const { data: vars } = await supa.from('productos_variantes').select('*').limit(500);
    let state = await getState(supa, k); if (!state) state = { telefono: k };

    const nuevoProd = detectarNuevoProducto(mensaje, vars || [], state.last_nombre);
    if (nuevoProd) { await saveState(supa, k, { last_nombre: nuevoProd.nombre_completo, last_precio: nuevoProd.precio, paso: null }); state.last_nombre = nuevoProd.nombre_completo; }

    const systemPrompt = buildSystemPrompt(vars || [], state, nombre, !!nuevoProd);
    const historial = await supa.from('whatsapp_conversations').select('entrada,respuesta').eq('telefono', k).order('created_at', { ascending: true }).limit(15);
    const messages: any[] = [{ role: 'system', content: systemPrompt }];
    if (historial.data) for (const h of historial.data) { messages.push({ role: 'user', content: h.entrada }); messages.push({ role: 'assistant', content: h.respuesta }); }
    messages.push({ role: 'user', content: mensaje });

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.3, messages })
    });
    const openaiJson = await openaiRes.json();
    const content = openaiJson.choices?.[0]?.message?.content || '{"accion":"respuesta_simple","respuesta":"Hola!"}';
    const parsed = parsearRespuestaIA(content, state.last_nombre || 'PORTA BEBES');

    let respFinal = (parsed.respuesta || '').replace(/\|/g, '\n');

    if (parsed.accion === 'confirmar_pedido') {
      const prodReal = vars?.find((v: any) => norm(v.nombre_completo).includes(norm(parsed.sku)));
      const link = `https://to2en1.app/shop/${slugify(parsed.sku)}`;
      await supa.from('whatsapp_orders').insert({
        telefono: k, nombre: parsed.nombre_cliente, telefono_cliente: k,
        direccion: parsed.direccion, items: [{ nombre: parsed.sku, talla: prodReal?.talla, color: prodReal?.color }], 
        total: prodReal?.precio || 15, estado: 'nuevo', metodo_pago: parsed.metodo_pago
      });
      await saveState(supa, k, { paso: 'confirmado', nombre_cliente: parsed.nombre_cliente, direccion: parsed.direccion, metodo_pago: parsed.metodo_pago, last_nombre: parsed.sku });
      respFinal = `✅ PEDIDO CONFIRMADO\n🛍️ ${parsed.sku}${prodReal?.talla ? `\n📏 Talla: ${prodReal.talla}` : ''}${prodReal?.color ? `\n🎨 Color: ${prodReal.color}` : ''}\n👤 ${parsed.nombre_cliente}\n📍 ${parsed.direccion}\n💳 ${parsed.metodo_pago}\n🔗 ${link}\n\n🚚 Envio GRATIS 24-72h en to2en1.app`;
    } else {
      const updates: any = {};
      if (parsed.sku) updates.last_nombre = parsed.sku;
      if (parsed.nombre_cliente) updates.nombre_cliente = parsed.nombre_cliente;
      if (parsed.direccion) updates.direccion = parsed.direccion;
      if (parsed.metodo_pago) updates.metodo_pago = parsed.metodo_pago;
      if (Object.keys(updates).length) await saveState(supa, k, updates);
    }

    await supa.from('whatsapp_conversations').insert({ telefono: k, entrada: mensajeConcatenado, respuesta: respFinal });
    await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`, {
      method: 'POST', headers: { 'apikey': process.env.EVOLUTION_API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: jid, text: respFinal })
    });
    return Response.json({ ok: true });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
