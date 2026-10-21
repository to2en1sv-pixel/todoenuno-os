import { createClient } from '@supabase/supabase-js';
export const dynamic = 'force-dynamic';

const norm = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const getKey = (jid: string) => jid.split('@')[0].replace(/[^0-9]/g,'').slice(-11);

function sanitizarInput(m: string) {
  if (m.length > 1000) m = m.substring(0, 1000);
  if (/ignora|system|prompt|jailbreak/i.test(m)) return "Hola, quisiera informacion";
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

// Detecta si el mensaje menciona un producto DIFERENTE al confirmado
function detectarNuevoProducto(mensaje: string, vars: any[], lastNombre: string | null) {
  const n = norm(mensaje);
  if (!lastNombre) return null;
  // Si pide otro producto explicito
  for (const v of vars) {
    const nom = norm(v.nombre_completo);
    if (n.includes(nom.split(' ')[0]) && nom !== norm(lastNombre) && n.length > 4) {
      if (nom !== norm(lastNombre)) return v;
    }
  }
  // keywords especificos
  if (n.includes('microfono') && !norm(lastNombre).includes('microfono')) {
    return vars.find((v: any) => norm(v.nombre_completo).includes('microfono'));
  }
  if (n.includes('porta') && n.includes('bebe') && !norm(lastNombre).includes('porta')) {
    return vars.find((v: any) => norm(v.nombre_completo).includes('porta'));
  }
  return null;
}

function buildSystemPrompt(vars: any[], state: any, nombre: string, esNuevoProducto: boolean) {
  const hora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/El_Salvador' })).getHours();
  const saludo = hora < 12 ? 'Buenos dias!' : hora < 18 ? 'Buenas tardes!' : 'Buenas noches!';

  let catalogoTexto = "";
  let productoConfirmado = "";

  // Si hay cambio de producto, NO mandes el viejo como confirmado
  if (state?.last_nombre && !esNuevoProducto) {
    const prod = vars.find((v: any) => norm(v.nombre_completo).includes(norm(state.last_nombre)));
    if (prod) {
      productoConfirmado = `PRODUCTO CONFIRMADO: ${prod.nombre_completo} | Precio: $${prod.precio || 15}`;
      catalogoTexto = `${prod.sku} | ${prod.nombre_completo} | ${prod.precio || 15}`;
    }
  } else {
    // Para "que mas tienes" o nuevo producto, manda lista amplia y ASEGURA porta bebes siempre
    const porta = vars.find((v: any) => norm(v.nombre_completo).includes('porta'));
    const lista = [porta, ...vars].filter(Boolean).slice(0, 25);
    catalogoTexto = lista.map((v: any) => `${v.sku || 'SKU'} | ${v.nombre_completo} | ${v.precio || 15}`).join(' || ');
  }

  return `Eres Todd, vendedor Todo en Uno El Salvador. Envio GRATIS.
CATALOGO: ${catalogoTexto}
${productoConfirmado}
NOMBRE: ${nombre}
SALUDO: ${saludo}

REGLA FORMATO JSON:
{"accion":"respuesta_simple o confirmar_pedido","sku":null,"nombre_cliente":null,"direccion":null,"metodo_pago":null,"respuesta":"mensaje"}
Usa | para saltos.

REGLA PRODUCTO:
${productoConfirmado && !esNuevoProducto ? `Producto ya confirmado: ${state.last_nombre}. Manten ese sku OBLIGATORIO a menos que el cliente pida OTRO producto diferente explicitamente.` : 'Identifica producto del catalogo. Si cliente dice "que mas tienes" lista 10 productos con emoji.'}

REGLA PEDIDO YA CERRADO:
Si paso=confirmado y cliente pregunta "porque cerraste pedido" responde: "Si, cerramos tu pedido de ${state?.last_nombre || 'PORTA BEBES'} a nombre de ${state?.nombre_cliente || ''}. Envio GRATIS 1-3 dias."

REGLA DATOS:
Pide: Nombre completo, Direccion (colonia, municipio, depto, calle, referencia), Metodo pago (efectivo o transferencia). Formato:
"Para coordinar tu pedido necesito estos datos:||📝 Nombre completo:|📍 Dirección: (colonia, municipio, departamento, calle y punto de referencia)|💳 Método de pago: (efectivo o transferencia)"
`;
}

function parsearRespuestaIA(raw: string, skuFallback: string) {
  let p: any;
  try { p = JSON.parse(raw.replace(/```json/g,'').replace(/```/g,'').trim()); } 
  catch { p = { accion: 'respuesta_simple', sku: skuFallback, respuesta: raw }; }
  if (!p.sku) p.sku = skuFallback;
  const tieneNombre = p.nombre_cliente?.length > 2;
  const tieneDir = p.direccion?.length > 5;
  const tienePago = p.metodo_pago?.length > 0;
  const tieneSku = p.sku?.length > 0;
  if (p.accion === 'confirmar_pedido' && (!tieneSku || !tieneNombre || !tieneDir || !tienePago)) {
    p.accion = 'respuesta_simple';
  }
  if (p.accion === 'respuesta_simple' && tieneNombre && tieneDir && tienePago && tieneSku) {
    p.accion = 'confirmar_pedido'; p.respuesta = "";
  }
  return p;
}

export async function GET() { return Response.json({ v: 'v26-fix-cambio-producto' }); }

export async function POST(req: Request) {
  const body = await req.json(); const d = body.data || body;
  if (d.key?.fromMe) return Response.json({ ok: true });
  const jid = d.key?.remoteJid || ''; const rawOriginal = (d.message?.conversation || d.message?.extendedTextMessage?.text || '').trim();
  if (!rawOriginal || !jid) return Response.json({ ok: true });
  const k = getKey(jid); const mensaje = sanitizarInput(rawOriginal); const nombre = d.pushName || 'Cliente';

  const supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
  const { data: vars } = await supa.from('productos_variantes').select('*').limit(3000);
  let state = await getState(supa, k); if (!state) state = { telefono: k };

  const nuevoProd = detectarNuevoProducto(mensaje, vars || [], state.last_nombre);
  const esNuevoProducto = !!nuevoProd;
  if (esNuevoProducto) {
    await saveState(supa, k, { last_nombre: nuevoProd.nombre_completo, last_precio: nuevoProd.precio || 15, paso: null });
    state.last_nombre = nuevoProd.nombre_completo;
  }

  const systemPrompt = buildSystemPrompt(vars || [], state, nombre, esNuevoProducto);
  const historial = await supa.from('whatsapp_conversations').select('entrada,respuesta').eq('telefono', k).order('created_at', { ascending: true }).limit(15);
  const messages: any[] = [{ role: 'system', content: systemPrompt }];
  if (historial.data) for (const h of historial.data) { messages.push({ role: 'user', content: h.entrada }); messages.push({ role: 'assistant', content: h.respuesta }); }
  messages.push({ role: 'user', content: mensaje });

  const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.4, messages })
  });
  const openaiJson = await openaiRes.json();
  const content = openaiJson.choices?.[0]?.message?.content || '{"accion":"respuesta_simple","respuesta":"Hola!"}';
  const parsed = parsearRespuestaIA(content, state.last_nombre || nuevoProd?.nombre_completo || 'PORTA BEBES');

  let respFinal = (parsed.respuesta || '').replace(/\|/g, '\n');

  if (parsed.accion === 'confirmar_pedido') {
    await supa.from('whatsapp_orders').insert({
      telefono: k, nombre: parsed.nombre_cliente, telefono_cliente: k,
      direccion: parsed.direccion, items: [{ nombre: parsed.sku }], total: 15, estado: 'nuevo', metodo_pago: parsed.metodo_pago
    });
    await saveState(supa, k, { paso: 'confirmado', nombre_cliente: parsed.nombre_cliente, direccion: parsed.direccion, last_nombre: parsed.sku });
    respFinal = `✅ PEDIDO CONFIRMADO\n🛍️ ${parsed.sku}\n👤 ${parsed.nombre_cliente}\n📍 ${parsed.direccion}\n💳 ${parsed.metodo_pago}\n\n🚚 Envio GRATIS 1-3 dias habiles`;
  } else {
    if (parsed.sku) await saveState(supa, k, { last_nombre: parsed.sku });
    if (parsed.nombre_cliente) await saveState(supa, k, { nombre_cliente: parsed.nombre_cliente });
    if (parsed.direccion) await saveState(supa, k, { direccion: parsed.direccion });
  }

  await supa.from('whatsapp_conversations').insert({ telefono: k, entrada: rawOriginal, respuesta: respFinal });
  await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`, {
    method: 'POST', headers: { 'apikey': process.env.EVOLUTION_API_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: jid, text: respFinal })
  });
  return Response.json({ ok: true });
}
