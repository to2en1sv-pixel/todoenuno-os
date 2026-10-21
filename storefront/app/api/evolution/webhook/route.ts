import { createClient } from '@supabase/supabase-js';
export const dynamic = 'force-dynamic';

const norm = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const getKey = (jid: string) => jid.split('@')[0].replace(/[^0-9]/g,'').slice(-11);
const DEPTOS = ["Ahuachapan","Santa Ana","Sonsonate","Chalatenango","La Libertad","San Salvador","Cuscatlan","La Paz","Cabanas","San Vicente","Usulutan","San Miguel","Morazan","La Union"];

// ==================== AGENTE 0: BUFFER + SANITIZAR - INICIO ====================
function sanitizarInput(mensaje: string) {
  if (mensaje.length > 1000) mensaje = mensaje.substring(0, 1000);
  const patrones = [/ignora\s+(las\s+)?instrucciones/i, /ignore\s+instructions/i, /olvida\s+todo/i, /actua\s+como/i, /eres\s+ahora/i, /system\s*:/i, /\[system\]/i, /prompt\s*:/i, /jailbreak/i];
  if (patrones.some(p => p.test(mensaje))) return "Hola, quisiera informacion sobre sus productos";
  return mensaje.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/`/g, "'").trim();
}
// ==================== AGENTE 0: FIN ====================

// ==================== AGENTE 1: PREPARAR CONTEXTO - INICIO ====================
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
// ==================== AGENTE 1: FIN ====================

// ==================== AGENTE 2: TODD + AAE PROMPT - INICIO ====================
function buildSystemPrompt(vars: any[], state: any, nombre: string) {
  const ahoraSV = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/El_Salvador' }));
  const hora = ahoraSV.getHours();
  const saludo = hora >= 5 && hora < 12 ? 'Buenos dias!' : hora >= 12 && hora < 18 ? 'Buenas tardes!' : 'Buenas noches!';
  
  const catalogoTexto = vars.map(v => {
    const sku = v.sku || 'SIN-SKU';
    const nom = v.nombre_completo || '';
    const precio = v.precio || 15;
    return `${sku} | ${nom} | ${precio}`;
  }).join(' || ');

  const ultimoSku = state?.last_nombre ? `PRODUCTO EN CONTEXTO: ${state.last_nombre}` : '';

  return `Eres Todd, vendedor de Todo en Uno por WhatsApp en El Salvador. Amable, directo y orientado a cerrar ventas. Envio GRATIS a todo El Salvador.
CATALOGO (SKU|Nombre|Precio): ${catalogoTexto}
${ultimoSku}
NOMBRE WHATSAPP: ${nombre}
SALUDO ACTUAL: ${saludo}

=== REGLA 1: FORMATO ===
Tu respuesta SIEMPRE es JSON valido sin texto adicional:
{"accion":"respuesta_simple o confirmar_pedido","sku":null,"nombre_cliente":null,"direccion":null,"metodo_pago":null,"respuesta":"mensaje al cliente"}
Usa | para saltos de linea. NUNCA uses \\n.

=== REGLA 2: PRODUCTO EN CONTEXTO ===
Si hay PRODUCTO EN CONTEXTO, ese SKU va OBLIGATORIO en campo sku en TODAS tus respuestas hasta que el cliente lo rechace.

=== REGLA 3: CONFIRMAR PEDIDO ===
Cuando tengas sku + nombre_cliente + direccion + metodo_pago, usa accion=confirmar_pedido con respuesta="". NUNCA uses confirmar_pedido si falta un dato.

=== REGLA 4: RECOLECTAR DATOS ===
Pide en orden:
1) Nombre completo
2) Direccion completa: Depto, Municipio, Colonia, Calle, referencia. Si viene incompleta pidela una vez mas; si sigue incompleta acepta lo que dio.
3) Metodo de pago: efectivo o transferencia.
Si el cliente da varios datos, extraelos todos y pide solo lo que falte. Formato:
"Para coordinar tu pedido necesito estos datos:||📝 Nombre completo:|📍 Dirección: (colonia, municipio, departamento, calle y punto de referencia)|💳 Método de pago: (efectivo o transferencia)"

=== REGLA 5: VENTAS ===
Envio GRATIS 1-3 dias habiles. Colores segun disponibilidad. Si no llegan a su zona ofrece puntos: Metrocentro, Plaza Mundo, Los Encuentros, Multiplaza, La Gran Via, Galerias. Abreviaturas ss = San Salvador.
`;
}
// ==================== AGENTE 2: FIN ====================

// ==================== AGENTE 3: PARSEAR RESPUESTA - INICIO ====================
function parsearRespuestaIA(raw: string, skuFallback: string) {
  let parsed: any;
  try {
    const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    parsed = { accion: 'respuesta_simple', sku: skuFallback, nombre_cliente: null, direccion: null, metodo_pago: null, respuesta: raw };
  }
  if (!parsed.sku) parsed.sku = skuFallback;

  const tieneNombre = parsed.nombre_cliente && parsed.nombre_cliente.length > 2;
  const tieneDir = parsed.direccion && parsed.direccion.length > 5;
  const tienePago = parsed.metodo_pago && parsed.metodo_pago.length > 0;
  const tieneSku = parsed.sku && parsed.sku.length > 0;

  if (parsed.accion === 'confirmar_pedido' && (!tieneSku || !tieneNombre || !tieneDir || !tienePago)) {
    parsed.accion = 'respuesta_simple';
    if (!tieneNombre) parsed.respuesta = "Para coordinar tu pedido necesito estos datos:||📝 Nombre completo:|📍 Dirección: (colonia, municipio, departamento, calle y punto de referencia)|💳 Método de pago: (efectivo o transferencia)";
  }
  if (parsed.accion === 'respuesta_simple' && tieneNombre && tieneDir && tienePago && tieneSku) {
    parsed.accion = 'confirmar_pedido';
    parsed.respuesta = "";
  }
  return parsed;
}
// ==================== AGENTE 3: FIN ====================

// ==================== AGENTE 4: LILI - INICIO ====================
export async function GET() { return Response.json({ v: 'v24-todd-aae-fusion' }); }

export async function POST(req: Request) {
  const body = await req.json();
  const d = body.data || body;
  if (d.key?.fromMe) return Response.json({ ok: true });
  const jid = d.key?.remoteJid || '';
  const rawOriginal = (d.message?.conversation || d.message?.extendedTextMessage?.text || '').trim();
  if (!rawOriginal || !jid) return Response.json({ ok: true });
  const k = getKey(jid);
  const mensaje = sanitizarInput(rawOriginal);
  const nombre = d.pushName || 'Cliente';

  const supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
  const { data: vars } = await supa.from('productos_variantes').select('*').limit(3000);
  let state = await getState(supa, k);
  if (!state) state = { telefono: k };

  const systemPrompt = buildSystemPrompt(vars || [], state, nombre);

  const historial = await supa.from('whatsapp_conversations').select('entrada,respuesta').eq('telefono', k).order('created_at', { ascending: true }).limit(20);
  const messages: any[] = [{ role: 'system', content: systemPrompt }];
  if (historial.data) {
    for (const h of historial.data) {
      messages.push({ role: 'user', content: h.entrada });
      messages.push({ role: 'assistant', content: h.respuesta });
    }
  }
  messages.push({ role: 'user', content: mensaje });

  const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.4, messages })
  });
  const openaiJson = await openaiRes.json();
  const content = openaiJson.choices?.[0]?.message?.content || '{"accion":"respuesta_simple","respuesta":"Hola! En que puedo ayudarte?"}';

  const parsed = parsearRespuestaIA(content, state.last_nombre || 'PORTA BEBES');

  let respFinal = (parsed.respuesta || '').replace(/\|/g, '\n');

  if (parsed.accion === 'confirmar_pedido') {
    await supa.from('whatsapp_orders').insert({
      telefono: k, nombre: parsed.nombre_cliente, telefono_cliente: k,
      departamento: 'San Salvador', municipio: 'San Salvador', direccion: parsed.direccion,
      items: [{ nombre: parsed.sku }], total: 15, estado: 'nuevo', metodo_pago: parsed.metodo_pago
    });
    await saveState(supa, k, { paso: 'confirmado', nombre_cliente: parsed.nombre_cliente, direccion: parsed.direccion });
    respFinal = `✅ PEDIDO CONFIRMADO\n🛍️ ${parsed.sku}\n👤 ${parsed.nombre_cliente}\n📍 ${parsed.direccion}\n💳 ${parsed.metodo_pago}\n\n🚚 Envio GRATIS 1-3 dias habiles`;
  } else {
    if (parsed.sku) await saveState(supa, k, { last_nombre: parsed.sku, last_precio: 15, paso: state.paso });
    if (parsed.nombre_cliente) await saveState(supa, k, { nombre_cliente: parsed.nombre_cliente });
    if (parsed.direccion) await saveState(supa, k, { direccion: parsed.direccion });
  }

  await supa.from('whatsapp_conversations').insert({ telefono: k, entrada: rawOriginal, respuesta: respFinal });
  await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`, {
    method: 'POST', headers: { 'apikey': process.env.EVOLUTION_API_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: jid, text: respFinal })
  });

  return Response.json({ ok: true, accion: parsed.accion });
}
// ==================== AGENTE 4: FIN ====================
