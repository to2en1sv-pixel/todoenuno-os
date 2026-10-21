import { createClient } from '@supabase/supabase-js';

const norm = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const toks = (s: string) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);
const DEPTOS = ["Ahuachapan","Santa Ana","Sonsonate","Chalatenango","La Libertad","San Salvador","Cuscatlan","La Paz","Cabanas","San Vicente","Usulutan","San Miguel","Morazan","La Union"];
const getKey = (jid: string) => jid.split('@')[0].replace(/^\+/,'').trim();

// ==================== AGENTE 1: CLASIFICADOR - INICIO ====================
function classifyIntent(raw: string, state: any) {
  if (state?.paso?.startsWith('collecting_')) return 'colectando';
  const n = norm(raw);
  if (/lo quiero|apartalo/i.test(n)) return 'comprar';
  if (/como.*pido|como.*pedido/i.test(n)) return 'como_pedir';
  if (/recuerdas|por cual/i.test(n)) return 'memoria';
  return 'buscar';
}
// ==================== AGENTE 1: FIN ====================

// ==================== AGENTE 2: BUSCADOR OS - INICIO ====================
async function searchOS(supa: any, vars: any[], raw: string) {
  const q = toks(raw).filter(w => !['quiero','informacion','del','para','hola'].includes(w));
  if (!q.length) return null;
  const scored = vars.map((v: any) => {
    const name = toks(v.nombre_completo || '');
    let s = 0;
    for (const qq of q) {
      if (name.includes(qq)) s += 30;
      if (qq === 'porta' && name.includes('porta') && !name.includes('portable')) s += 50;
      if (qq === 'porta' && name.includes('portable')) s -= 40;
    }
    return { ...v, _score: s };
  }).filter((v: any) => v._score > 0).sort((a: any, b: any) => b._score - a._score);
  let prod = scored[0] || null;
  if (!prod && /porta.*bebe/i.test(norm(raw))) prod = vars.find((v: any) => norm(v.nombre_completo).includes('porta bebe') || norm(v.nombre_completo).includes('portabebe')) || null;
  if (!prod) return null;
  return { ...prod, precio_final: prod.precio || 15, talla: prod.talla || 'Unica', color: prod.color || 'Unica' };
}
// ==================== AGENTE 2: FIN ====================

// ==================== AGENTE 3: CHECKOUT ESTRICTO - INICIO ====================
function validar(tipo: string, valor: string) {
  const t = valor.trim();
  if (tipo === 'nombre') {
    if (t.split(' ').filter(w => w.length >= 2).length < 2) return { ok: false, msg: '❌ Dame nombre y apellido Ej: Cristian Peña' };
    return { ok: true, val: t };
  }
  if (tipo === 'telefono') {
    const num = t.replace(/\D/g, '').slice(-8);
    if (num.length !== 8) return { ok: false, msg: '❌ 8 digitos Ej: 77974768' };
    return { ok: true, val: num };
  }
  if (tipo === 'departamento') {
    const found = DEPTOS.find(d => norm(d).includes(norm(t)) || norm(t).includes(norm(d)));
    if (!found) return { ok: false, msg: `❌ Depto: ${DEPTOS.join(', ')}` };
    return { ok: true, val: found };
  }
  if (tipo === 'municipio' && t.length < 3) return { ok: false, msg: '❌ Municipio corto' };
  if (tipo === 'direccion' && t.length < 10) return { ok: false, msg: '❌ Direccion corta Ej: Colonia X #12' };
  return { ok: true, val: t };
}

async function checkoutFlowContinuo(supa: any, phoneKey: string) {
  const { data: st } = await supa.from('whatsapp_state').select('*').eq('telefono', phoneKey).order('updated_at', {ascending:false}).limit(1).maybeSingle();
  const state = st;
  const falta = !state?.nombre_cliente ? 'nombre' : !state?.telefono_cliente ? 'telefono' : !state?.departamento ? 'departamento' : !state?.municipio ? 'municipio' : !state?.direccion ? 'direccion' : null;
  if (!falta) {
    await supa.from('whatsapp_orders').insert({ telefono: phoneKey, nombre: state.nombre_cliente, telefono_cliente: state.telefono_cliente, departamento: state.departamento, municipio: state.municipio, direccion: state.direccion, items: [{ nombre: state.last_nombre }], total: state.last_precio, estado: 'nuevo' });
    await supa.from('whatsapp_state').upsert({ telefono: phoneKey, paso: 'confirmado' }, { onConflict: 'telefono' });
    return `✅ *PEDIDO CONFIRMADO*\n🛍️ ${state.last_nombre}\n👤 ${state.nombre_cliente}\n📱 ${state.telefono_cliente}\n📍 ${state.departamento}, ${state.municipio}\n🏠 ${state.direccion}`;
  } else {
    const msgs: any = { nombre: `1️⃣ Nombre completo Ej: Cristian Castro`, telefono: `2️⃣ Tel 8 digitos Ej: 77974768`, departamento: `3️⃣ Depto ${DEPTOS.join(', ')}`, municipio: `4️⃣ Municipio Ej: Soyapango`, direccion: `5️⃣ Direccion exacta` };
    await supa.from('whatsapp_state').upsert({ telefono: phoneKey, paso: `collecting_${falta}` }, { onConflict: 'telefono' });
    return msgs[falta];
  }
}
// ==================== AGENTE 3: FIN ====================

// ==================== AGENTE 4: LILI VENDEDORA - INICIO ====================
function formatLILI(prod: any) {
  return `🛍️ *${prod.nombre_completo}*\n💰 *$${prod.precio_final}*\n🎨 Talla: *${prod.talla}* | Color: *${prod.color}*\n📦 Disponible ✅\n\n¿Te lo aparto? Escribe "lo quiero" 🚚`;
}
// ==================== AGENTE 4: FIN ====================

export async function GET() { return Response.json({ v: 'v19-no-busca-en-colecta' }); }

export async function POST(req: Request) {
  const body = await req.json(); const d = body.data || body;
  if (d.key?.fromMe) return Response.json({ ok: true });
  const jid = d.key?.remoteJid || ''; const raw = (d.message?.conversation || d.message?.extendedTextMessage?.text || '').trim();
  if (!raw || !jid) return Response.json({ ok: true });
  const phoneKey = getKey(jid);

  const supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
  const { data: vars } = await supa.from('productos_variantes').select('*').limit(3000);
  const { data: st } = await supa.from('whatsapp_state').select('*').eq('telefono', phoneKey).order('updated_at',{ascending:false}).limit(1).maybeSingle();
  let state = st || { telefono: phoneKey };

  const intent = classifyIntent(raw, state);
  let prod = null;
  // FIX IMPORTANTE: No buscar producto si estamos colectando datos
  if (intent !== 'colectando') {
    prod = await searchOS(supa, vars || [], raw);
    if (!prod && (intent === 'comprar' || intent === 'memoria') && state?.last_nombre) {
      prod = { nombre_completo: state.last_nombre, precio_final: state.last_precio, sku: state.last_sku, talla: state.last_talla, color: state.last_color };
    }
  }

  let resp = '';
  if (intent === 'colectando') {
    const campo = state.paso.replace('collecting_', '');
    const v = validar(campo, raw);
    if (!v.ok) resp = v.msg;
    else {
      const col = campo === 'nombre' ? 'nombre_cliente' : campo === 'telefono' ? 'telefono_cliente' : campo;
      await supa.from('whatsapp_state').upsert({ telefono: phoneKey, [col]: v.val }, { onConflict: 'telefono' });
      resp = await checkoutFlowContinuo(supa, phoneKey);
    }
  } else if (intent === 'comprar') {
    if (prod) await supa.from('whatsapp_state').upsert({ telefono: phoneKey, last_sku: prod.sku, last_nombre: prod.nombre_completo, last_precio: prod.precio_final, last_talla: prod.talla, last_color: prod.color }, { onConflict: 'telefono' });
    resp = await checkoutFlowContinuo(supa, phoneKey);
  } else {
    if (prod) {
      await supa.from('whatsapp_state').upsert({ telefono: phoneKey, last_sku: prod.sku, last_nombre: prod.nombre_completo, last_precio: prod.precio_final, last_talla: prod.talla, last_color: prod.color }, { onConflict: 'telefono' });
      resp = formatLILI(prod);
    } else {
      resp = `¡Hola! Tengo ${vars?.length || 0} productos. Escribe "porta bebes"`;
    }
  }

  await supa.from('whatsapp_conversations').insert({ telefono: phoneKey, entrada: raw, respuesta: resp });
  await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`, { method: 'POST', headers: { 'apikey': process.env.EVOLUTION_API_KEY!, 'Content-Type': 'application/json' }, body: JSON.stringify({ number: jid, text: resp }) });
  return Response.json({ ok: true, intent });
}
