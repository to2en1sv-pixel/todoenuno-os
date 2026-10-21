import { createClient } from '@supabase/supabase-js';
export const dynamic = 'force-dynamic';

const norm = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const getKey = (jid: string) => jid.split('@')[0].replace(/[^0-9]/g,'').slice(-11);

function sanitizarInput(m: string) {
  if (m.length > 1000) m = m.substring(0, 1000);
  return m.trim();
}
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
  if (n.includes('microfono') && !norm(lastNombre||'').includes('microfono')) return vars.find((v: any) => norm(v.nombre_completo).includes('microfono'));
  if (n.includes('porta') && n.includes('bebe')) return vars.find((v: any) => norm(v.nombre_completo).includes('porta'));
  return null;
}

function buildSystemPrompt(vars: any[], state: any, nombre: string, esNuevo: boolean) {
  const hora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/El_Salvador' })).getHours();
  const saludo = hora < 12 ? 'Buenos dias!' : hora < 18 ? 'Buenas tardes!' : 'Buenas noches!';
  let catalogoTexto = ""; let productoConfirmado = "";
  if (state?.last_nombre && !esNuevo) {
    const prod = vars.find((v: any) => norm(v.nombre_completo).includes(norm(state.last_nombre)));
    if (prod) {
      const talla = prod.talla || 'Única';
      const color = prod.color || 'Único';
      productoConfirmado = `PRODUCTO CONFIRMADO: ${prod.nombre_completo} | Precio: $${prod.precio || 15} | Talla: ${talla} | Color: ${color}`;
      catalogoTexto = `${prod.sku} | ${prod.nombre_completo} | ${prod.precio || 15} | Talla ${talla} Color ${color}`;
    }
  } else {
    const porta = vars.find((v: any) => norm(v.nombre_completo).includes('porta'));
    const lista = [porta, ...vars].filter(Boolean).slice(0, 25);
    catalogoTexto = lista.map((v: any) => `${v.sku || 'SKU'} | ${v.nombre_completo} | ${v.precio || 15} | Talla ${v.talla || 'Única'} Color ${v.color || 'Único'}`).join(' || ');
  }
  return `Eres Todd, vendedor Todo en Uno El Salvador. Envio GRATIS 1-3 dias.
CATALOGO: ${catalogoTexto}
${productoConfirmado}
NOMBRE: ${nombre} SALUDO: ${saludo}
JSON: {"accion":"respuesta_simple o confirmar_pedido","sku":null,"nombre_cliente":null,"direccion":null,"metodo_pago":null,"talla":null,"color":null,"respuesta":"mensaje"}
Usa | para salto.

REGLA: ${productoConfirmado && !esNuevo ? `Mantén ${state.last_nombre} obligatorio. Talla: ${state.last_talla || 'Única'} Color: ${state.last_color || 'Único'} si no detectas.` : 'Si pide "que mas tienes" lista 10 productos con emoji.'}

REGLA DATOS: Extrae TODO de un solo mensaje aunque venga en 2 lineas. Ej: "Juan arnulfo. Colonia escalon San Salvador Efectivo" => nombre=Juan arnulfo, direccion=Colonia escalon San Salvador, pago=efectivo, talla=Única, color=Único.

REGLA CONFIRMACION: Cuando tengas sku+nombre+direccion+pago => confirmar_pedido con respuesta="".
Formato pedido:
"Para coordinar tu pedido necesito estos datos:||📝 Nombre completo:|📍 Dirección: (colonia, municipio, departamento, calle y punto de referencia)|💳 Método de pago: (efectivo o transferencia)"
`;
}

function parsearRespuestaIA(raw: string, skuFallback: string) {
  let p: any;
  try { p = JSON.parse(raw.replace(/```json/g,'').replace(/```/g,'').trim()); } catch { p = { accion: 'respuesta_simple', sku: skuFallback, respuesta: raw }; }
  if (!p.sku) p.sku = skuFallback;
  if (!p.talla) p.talla = 'Única';
  if (!p.color) p.color = 'Único';
  const tieneNombre = p.nombre_cliente?.length > 2;
  const tieneDir = p.direccion?.length > 5;
  const tienePago = p.metodo_pago?.length > 0;
  const tieneSku = p.sku?.length > 0;
  if (p.accion === 'confirmar_pedido' && (!tieneSku || !tieneNombre || !tieneDir || !tienePago)) p.accion = 'respuesta_simple';
  if (p.accion === 'respuesta_simple' && tieneNombre && tieneDir && tienePago && tieneSku) { p.accion = 'confirmar_pedido'; p.respuesta = ""; }
  return p;
}

export async function GET() { return Response.json({ v: 'v28-buffer-talla-color' }); }

export async function POST(req: Request) {
  try {
    const body = await req.json(); const d = body.data || body;
    if (d.key?.fromMe) return Response.json({ ok: true });
    const jid = d.key?.remoteJid || ''; const rawOriginal = (d.message?.conversation || d.message?.extendedTextMessage?.text || '').trim();
    if (!rawOriginal || !jid) return Response.json({ ok: true });
    const k = getKey(jid);

    const supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

    // ===== BUFFER COMO AAE - INICIO =====
    const { data: inserted } = await supa.from('whatsapp_buffer').insert({ telefono: k, mensaje: rawOriginal }).select('id').single();
    const idBuffer = inserted?.id;
    await new Promise(r => setTimeout(r, 3000)); // espera 3 seg como en n8n
    const { data: ultimo } = await supa.from('whatsapp_buffer').select('id').eq('telefono', k).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (String(idBuffer) !== String(ultimo?.id)) {
      return Response.json({ ok: true, buffered: true }); // no es el ultimo, descarta
    }
    const { data: mensajes } = await supa.from('whatsapp_buffer').select('mensaje').eq('telefono', k).order('created_at', { ascending: true });
    const mensajeConcatenado = mensajes?.map((m: any) => m.mensaje).join(' ') || rawOriginal;
    await supa.from('whatsapp_buffer').delete().eq('telefono', k);
    // ===== BUFFER - FIN =====

    const mensaje = sanitizarInput(mensajeConcatenado);
    const nombre = d.pushName || 'Cliente';
    const { data: vars } = await supa.from('productos_variantes').select('*').limit(3000);
    let state = await getState(supa, k); if (!state) state = { telefono: k };
    const nuevoProd = detectarNuevoProducto(mensaje, vars || [], state.last_nombre);
    if (nuevoProd) { await saveState(supa, k, { last_nombre: nuevoProd.nombre_completo, last_precio: nuevoProd.precio || 15, last_talla: nuevoProd.talla || 'Única', last_color: nuevoProd.color || 'Único', paso: null }); state.last_nombre = nuevoProd.nombre_completo; }

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
      await supa.from('whatsapp_orders').insert({
        telefono: k, nombre: parsed.nombre_cliente, telefono_cliente: k,
        direccion: parsed.direccion, items: [{ nombre: parsed.sku, talla: parsed.talla, color: parsed.color }], total: 15, estado: 'nuevo', metodo_pago: parsed.metodo_pago
      });
      await saveState(supa, k, { paso: 'confirmado', nombre_cliente: parsed.nombre_cliente, direccion: parsed.direccion, metodo_pago: parsed.metodo_pago, last_nombre: parsed.sku, last_talla: parsed.talla, last_color: parsed.color });
      respFinal = `✅ PEDIDO CONFIRMADO\n🛍️ ${parsed.sku}\n🎨 Talla: ${parsed.talla} | Color: ${parsed.color}\n👤 ${parsed.nombre_cliente}\n📍 ${parsed.direccion}\n💳 ${parsed.metodo_pago}\n\n🚚 Envio GRATIS 1-3 dias habiles`;
    } else {
      const updates: any = {};
      if (parsed.sku) updates.last_nombre = parsed.sku;
      if (parsed.talla) updates.last_talla = parsed.talla;
      if (parsed.color) updates.last_color = parsed.color;
      if (parsed.nombre_cliente) updates.nombre_cliente = parsed.nombre_cliente;
      if (parsed.direccion) updates.direccion = parsed.direccion;
      if (parsed.metodo_pago) updates.metodo_pago = parsed.metodo_pago;
      if (Object.keys(updates).length > 0) await saveState(supa, k, updates);
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
