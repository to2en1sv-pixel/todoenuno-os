import { createClient } from '@supabase/supabase-js';

// ==================== PROMPTS EDITABLES - SOLO TOCAS ESTO ====================
const PROMPTS = {
  CLASIFICADOR: `Clasifica: comprar, como_pedir, memoria, colectando, buscar`,
  LILI: `Eres LILI TodoEnUno. Formatea: nombre, precio, talla, color, descripcion. Emojis 🛍️💰🎨📝📦🚚 *negritas* corto`,
  CHECKOUT: `Estricto: nombre 2 palabras, tel 8 digitos 6/7, depto de 14 SV, municipio 3 letras, direccion 10 chars`,
  BUSCADOR: `porta != portable (-40pts), bebes=bebe, porta+bebe=+70pts, nunca producto_id`
};

// ==================== HELPERS GLOBALES ====================
const norm = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const toks = (s: string) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);
const DEPTOS = ["Ahuachapan","Santa Ana","Sonsonate","Chalatenango","La Libertad","San Salvador","Cuscatlan","La Paz","Cabanas","San Vicente","Usulutan","San Miguel","Morazan","La Union"];

// ==================== AGENTE 1: CLASIFICADOR - INICIO ====================
function classifyIntent(raw: string, state: any) {
  const n = norm(raw);
  if (/lo quiero|apartalo/i.test(n)) return 'comprar';
  if (/como.*pido|como.*pedido/i.test(n)) return 'como_pedir';
  if (/recuerdas|por cual/i.test(n)) return 'memoria';
  if (state?.paso?.startsWith('collecting_')) return 'colectando';
  return 'buscar';
}
// ==================== AGENTE 1: CLASIFICADOR - FIN ====================

// ==================== AGENTE 2: BUSCADOR OS (0 LLM) - INICIO ====================
async function searchOS(supa: any, vars: any[], raw: string) {
  if (!vars?.length) return null;
  const q = toks(raw).filter(w => !['quiero','informacion','del','para','hola'].includes(w));
  const scored = vars.map((v: any) => {
    const name = toks(v.nombre_completo || '');
    let s = 0;
    for (const qq of q) {
      if (name.includes(qq)) s += 30;
      if ((qq === 'bebes' || qq === 'bebe') && name.some((t: string) => t.startsWith('bebe'))) s += 30;
      if (qq === 'porta' && name.includes('porta') && !name.includes('portable')) s += 50;
      if (qq === 'porta' && name.includes('portable')) s -= 40;
    }
    if (q.length >= 2 && q.every((x: string) => name.includes(x) || (x === 'bebes' && name.includes('bebe')))) s += 60;
    return { ...v, _score: s };
  }).filter((v: any) => v._score > 0).sort((a: any, b: any) => b._score - a._score);
  
  let prod = scored[0] || null;
  if (!prod && /porta.*bebe/i.test(norm(raw))) prod = vars.find((v: any) => norm(v.nombre_completo).includes('porta') && norm(v.nombre_completo).includes('bebe')) || null;
  if (!prod && /urinario/i.test(norm(raw))) prod = vars.find((v: any) => norm(v.nombre_completo).includes('urinario')) || null;
  if (!prod) return null;

  // Enriquece con productos para talla/color/descripcion
  let precio = prod.precio || 15;
  let talla = prod.talla || 'Unica';
  let color = prod.color || 'Unica';
  let descripcion = prod.descripcion || '';
  if (prod.template_id) {
    const { data: p } = await supa.from('productos').select('*').eq('id', prod.template_id).single();
    if (p) {
      precio = prod.precio || p.precio || p.list_price || precio;
      descripcion = p.descripcion || p.description || descripcion;
    }
  }
  return { ...prod, precio_final: precio, talla, color, descripcion };
}
// ==================== AGENTE 2: BUSCADOR OS - FIN ====================

// ==================== AGENTE 3: CHECKOUT ESTRICTO - INICIO ====================
function validar(tipo: string, valor: string) {
  const t = valor.trim();
  if (tipo === 'nombre') {
    if (t.split(' ').filter(w => w.length >= 2).length < 2) return { ok: false, msg: '❌ Escribí tu *nombre completo* Ej: Cristian Castro' };
    return { ok: true, val: t };
  }
  if (tipo === 'telefono') {
    const num = t.replace(/\D/g, '').slice(-8);
    if (num.length !== 8 || !/^[67]/.test(num)) return { ok: false, msg: '❌ Tel debe ser 8 digitos y empezar con 6 o 7 Ej: 77974768' };
    return { ok: true, val: num };
  }
  if (tipo === 'departamento') {
    const found = DEPTOS.find(d => norm(d) === norm(t) || norm(d).includes(norm(t)) || norm(t).includes(norm(d)));
    if (!found) return { ok: false, msg: `❌ Depto invalido. Usa: ${DEPTOS.join(', ')}` };
    return { ok: true, val: found };
  }
  if (tipo === 'municipio') {
    if (t.length < 3) return { ok: false, msg: '❌ Municipio muy corto Ej: Soyapango' };
    return { ok: true, val: t };
  }
  if (tipo === 'direccion') {
    if (t.length < 10) return { ok: false, msg: '❌ Direccion muy corta Ej: Colonia Escalón #12 frente a farmacia' };
    return { ok: true, val: t };
  }
  return { ok: true, val: t };
}

async function checkoutFlowContinuo(supa: any, jid: string) {
  const { data: st } = await supa.from('whatsapp_state').select('*').eq('telefono', jid).single();
  const state = st;
  const falta = !state?.nombre_cliente ? 'nombre' : !state?.telefono_cliente ? 'telefono' : !state?.departamento ? 'departamento' : !state?.municipio ? 'municipio' : !state?.direccion ? 'direccion' : null;

  if (!falta) {
    await supa.from('whatsapp_orders').insert({
      telefono: jid, nombre: state.nombre_cliente, telefono_cliente: state.telefono_cliente,
      departamento: state.departamento, municipio: state.municipio, direccion: state.direccion,
      items: [{ nombre: state.last_nombre, precio: state.last_precio }], total: state.last_precio, estado: 'nuevo'
    });
    await supa.from('whatsapp_state').upsert({ telefono: jid, paso: 'confirmado' }, { onConflict: 'telefono' });
    return `✅ *PEDIDO CONFIRMADO*\n🛍️ ${state.last_nombre} $${state.last_precio}\n👤 ${state.nombre_cliente}\n📱 ${state.telefono_cliente}\n📍 ${state.departamento}, ${state.municipio}\n🏠 ${state.direccion}\n\n🚚 Te contactamos en <2h`;
  } else {
    const msgs: any = {
      nombre: `1️⃣ *Nombre completo* Ej: Cristian Castro`,
      telefono: `2️⃣ *Tel 8 digitos* Ej: 77974768`,
      departamento: `3️⃣ *Departamento* Ej: San Salvador\nValidos: ${DEPTOS.join(', ')}`,
      municipio: `4️⃣ *Municipio* Ej: Soyapango`,
      direccion: `5️⃣ *Direccion exacta* con colonia, # casa y referencia Ej: Col Escalón calle #12 frente a farmacia`
    };
    await supa.from('whatsapp_state').upsert({ telefono: jid, paso: `collecting_${falta}` }, { onConflict: 'telefono' });
    return msgs[falta];
  }
}
// ==================== AGENTE 3: CHECKOUT ESTRICTO - FIN ====================

// ==================== AGENTE 4: LILI VENDEDORA (FORMATEO) - INICIO ====================
function formatLILI(prod: any) {
  if (!prod) return null;
  const desc = prod.descripcion ? `\n📝 ${prod.descripcion.slice(0, 100)}` : '';
  return `🛍️ *${prod.nombre_completo}*\n💰 *$${prod.precio_final || prod.precio}*\n🎨 Talla: *${prod.talla}* | Color: *${prod.color}*${desc}\n📦 Disponible ✅\n\n¿Te lo aparto? Escribe "lo quiero" 🚚`;
}
// ==================== AGENTE 4: LILI VENDEDORA - FIN ====================

// ==================== ORQUESTADOR PRINCIPAL ====================
export async function GET() { return Response.json({ v: 'v17-4-agentes-delimitados' }); }

export async function POST(req: Request) {
  const body = await req.json(); const d = body.data || body;
  if (d.key?.fromMe) return Response.json({ ok: true });
  const jid = d.key?.remoteJid || ''; const raw = (d.message?.conversation || d.message?.extendedTextMessage?.text || '').trim();
  if (!raw || !jid) return Response.json({ ok: true });

  const supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
  const { data: vars } = await supa.from('productos_variantes').select('*').limit(3000);
  const { data: st } = await supa.from('whatsapp_state').select('*').eq('telefono', jid).single();
  let state = st || { telefono: jid };

  const intent = classifyIntent(raw, state);
  let prod = await searchOS(supa, vars || [], raw);
  if (!prod && (intent === 'comprar' || intent === 'memoria') && state?.last_nombre) {
    prod = { nombre_completo: state.last_nombre, precio: state.last_precio, sku: state.last_sku, talla: state.last_talla, color: state.last_color, precio_final: state.last_precio };
  }

  let resp = '';
  if (intent === 'colectando') {
    const campo = state.paso.replace('collecting_', '');
    const v = validar(campo, raw);
    if (!v.ok) {
      resp = v.msg;
    } else {
      const col = campo === 'nombre' ? 'nombre_cliente' : campo === 'telefono' ? 'telefono_cliente' : campo;
      await supa.from('whatsapp_state').upsert({ telefono: jid, [col]: v.val }, { onConflict: 'telefono' });
      resp = await checkoutFlowContinuo(supa, jid); // FIX: sigue pidiendo el siguiente, no se pone idle
    }
  } else if (intent === 'comprar') {
    if (prod) await supa.from('whatsapp_state').upsert({ telefono: jid, last_sku: prod.sku, last_nombre: prod.nombre_completo, last_precio: prod.precio_final || prod.precio, last_talla: prod.talla, last_color: prod.color }, { onConflict: 'telefono' });
    resp = await checkoutFlowContinuo(supa, jid);
  } else if (intent === 'como_pedir') {
    resp = `Para pedir 🚚\n1. Decí producto\n2. Decí "lo quiero"\n3. Te pido datos completos\n4. Resumen`;
  } else {
    if (prod) {
      await supa.from('whatsapp_state').upsert({ telefono: jid, last_sku: prod.sku, last_nombre: prod.nombre_completo, last_precio: prod.precio_final || prod.precio, last_talla: prod.talla, last_color: prod.color }, { onConflict: 'telefono' });
      resp = formatLILI(prod)!;
    } else {
      resp = `¡Hola! Tengo ${vars?.length || 0} productos. Escribe "porta bebes" o "urinario rana"`;
    }
  }

  await supa.from('whatsapp_conversations').insert({ telefono: jid, entrada: raw, respuesta: resp });
  await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`, { method: 'POST', headers: { 'apikey': process.env.EVOLUTION_API_KEY!, 'Content-Type': 'application/json' }, body: JSON.stringify({ number: jid, text: resp }) });
  return Response.json({ ok: true, intent });
}
