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
function buildSystemPrompt(vars: any[], state: any, nombre: string) {
  const ahoraSV = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/El_Salvador' }));
  const hora = ahoraSV.getHours();
  const saludo = hora >= 5 && hora < 12 ? 'Buenos dias!' : hora >= 12 && hora < 18 ? 'Buenas tardes!' : 'Buenas noches!';

  // FIX: Si ya hay producto en contexto, solo manda ESE producto, no los 91
  let catalogoTexto = "";
  let productoConfirmado = "";
  if (state?.last_nombre) {
    const prod = vars.find((v: any) => norm(v.nombre_completo).includes(norm(state.last_nombre)) || norm(state.last_nombre).includes(norm(v.nombre_completo)));
    if (prod) {
      productoConfirmado = `PRODUCTO CONFIRMADO: ${prod.nombre_completo} | SKU: ${prod.sku || prod.nombre_completo} | Precio: $${prod.precio || 15}`;
      catalogoTexto = `${prod.sku} | ${prod.nombre_completo} | ${prod.precio || 15}`;
    }
  } else {
    catalogoTexto = vars.slice(0, 20).map((v: any) => `${v.sku || 'SKU'} | ${v.nombre_completo} | ${v.precio || 15}`).join(' || ');
  }

  return `Eres Todd, vendedor de Todo en Uno por WhatsApp en El Salvador. Amable, directo y orientado a cerrar ventas. Envio GRATIS a todo El Salvador.
CATALOGO: ${catalogoTexto}
${productoConfirmado}
NOMBRE WHATSAPP: ${nombre}
SALUDO ACTUAL: ${saludo}

=== REGLA 1: FORMATO ===
Tu respuesta SIEMPRE es JSON valido:
{"accion":"respuesta_simple o confirmar_pedido","sku":"${state?.last_nombre || 'PORTA BEBES'}","nombre_cliente":null,"direccion":null,"metodo_pago":null,"respuesta":"mensaje"}
Usa | para saltos de linea.

=== REGLA 2: PRODUCTO EN CONTEXTO - CRITICA ===
${productoConfirmado ? `El producto ya esta CONFIRMADO: ${state.last_nombre}. Usa OBLIGATORIAMENTE ese mismo sku en TODAS tus respuestas. PROHIBIDO cambiarlo a otro producto como chancla, cangurera, etc. Solo cambias si el cliente dice explicitamente "no quiero ese, quiero X" ` : 'Identifica el producto del catalogo de forma semantica.'}

=== REGLA 3: CONFIRMAR PEDIDO ===
Cuando tengas sku + nombre_cliente + direccion + metodo_pago, usa accion=confirmar_pedido con respuesta="". NUNCA uses confirmar_pedido si falta un dato.

=== REGLA 4: RECOLECTAR DATOS ===
Pide: Nombre completo, Direccion completa (colonia, municipio, departamento, calle, referencia), Metodo de pago (efectivo o transferencia). Formato:
"Para coordinar tu pedido necesito estos datos:||📝 Nombre completo:|📍 Dirección: (colonia, municipio, departamento, calle y punto de referencia)|💳 Método de pago: (efectivo o transferencia)"
Si el cliente da varios datos, extraelos todos y pide solo lo que falte.
`;
}

// ==================== AGENTE 3: PARSEAR RESPUESTA - INICIO ====================
// ==================== AGENTE 3: PARSEAR RESPUESTA - INICIO ====================
function parsearRespuestaIA(raw: string, skuFallback: string) {
  let parsed: any;
  try {
    const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    parsed = { accion: 'respuesta_simple', sku: skuFallback, nombre_cliente: null, direccion: null, metodo_pago: null, respuesta: raw };
  }

  // FIX ANTI-CHANCLA: si ya hay producto confirmado, no dejar que el LLM cambie a otro
  if (skuFallback && skuFallback.length > 3) {
    // Solo permite cambio si el usuario dijo explicitamente otro producto
    // Por ahora forzamos el fallback que es PORTA BEBES
    if (!parsed.sku || parsed.sku.toLowerCase().includes('chancla') || parsed.sku.toLowerCase().includes('confort')) {
      parsed.sku = skuFallback;
    }
  }

  if (!parsed.sku) parsed.sku = skuFallback;

  const tieneNombre = parsed.nombre_cliente && parsed.nombre_cliente.length > 2;
  const tieneDir = parsed.direccion && parsed.direccion.length > 5;
  const tienePago = parsed.metodo_pago && parsed.metodo_pago.length > 0;
  const tieneSku = parsed.sku && parsed.sku.length > 0;

  if (parsed.accion === 'confirmar_pedido' && (!tieneSku || !tieneNombre || !tieneDir || !tienePago)) {
    parsed.accion = 'respuesta_simple';
    if (!tieneNombre) {
      parsed.respuesta = "Para coordinar tu pedido necesito estos datos:||📝 Nombre completo:|📍 Dirección: (colonia, municipio, departamento, calle y punto de referencia)|💳 Método de pago: (efectivo o transferencia)";
    }
  }

  if (parsed.accion === 'respuesta_simple' && tieneNombre && tieneDir && tienePago && tieneSku) {
    parsed.accion = 'confirmar_pedido';
    parsed.respuesta = "";
  }

  return parsed;
}
// ==================== AGENTE 3: FIN ====================
// ==================== AGENTE 4: FIN ====================
