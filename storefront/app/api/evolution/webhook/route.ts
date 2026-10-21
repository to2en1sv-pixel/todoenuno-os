import { createClient } from '@supabase/supabase-js';

// ==================== PARTE 1: SOLO PROMPTS - AQUÍ ES DONDE EDITAS ====================
const PROMPTS = {
  CLASIFICADOR: `
  Eres clasificador. Devuelve SOLO una palabra:
    - comprar si dice lo quiero, apartalo
    - como_pedir si pregunta como pedir
    - memoria si pregunta que me preguntó
    - colectando si está dando datos
    - buscar en cualquier otro caso
  `,

  LILI_VENDEDORA: `
  Eres LILI de TodoEnUno, tienda de El Salvador. 
  Formatea producto: nombre, precio, talla, color, descripcion corta.
  Usa emojis 🛍️ 💰 🎨 📝 📦 🚚 y *negritas*.
  Nunca inventes stock. Nunca digas sin stock. Respuesta corta max 4 lineas.
  Si no hay talla/color pon "Talla: Única | Color: Variado"
  `,

  CHECKOUT_ESTRICTO: `
  Eres checkout estricto. No cierres pedido hasta tener:
    1. nombre completo = 2 palabras minimo, solo letras
    2. telefono = 8 digitos, empieza con 6 o 7
    3. departamento = uno de los 14 de El Salvador
    4. municipio = minimo 3 letras
    5. direccion = minimo 10 caracteres con colonia y # casa
  Si falta algo, pide SOLO ese dato con ejemplo.
  `,

  BUSCADOR_REGLAS: `
  Reglas buscador sin LLM:
    - porta NO debe matchear portable (penaliza -40)
    - bebes = bebe
    - Si busca porta bebes, debe tener porta Y bebe = +70 pts
    - Nunca uses producto_id, esa columna no existe en xpnz
    - Usa select * para evitar "column does not exist"
  `
};

// ==================== PARTE 2: SOLO CODIGO - NO EDITAR A MENOS QUE FALLE BUILD ====================
const norm = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const toks = (s: string) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);
const DEPTOS = ["Ahuachapan","Santa Ana","Sonsonate","Chalatenango","La Libertad","San Salvador","Cuscatlan","La Paz","Cabanas","San Vicente","Usulutan","San Miguel","Morazan","La Union"];

function classifyIntent(raw: string, state: any) {
  const n = norm(raw);
  if (/lo quiero|apartalo/i.test(n)) return 'comprar';
  if (/como.*pido|como.*pedido/i.test(n)) return 'como_pedir';
  if (/recuerdas|por cual/i.test(n)) return 'memoria';
  if (state?.paso?.startsWith('collecting_')) return 'colectando';
  return 'buscar';
}

function searchOS(vars: any[], raw: string) {
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
  return prod;
}

function validar(tipo: string, valor: string) {
  const t = valor.trim();
  if (tipo === 'nombre') {
    if (t.split(' ').filter(w => w.length >= 2).length < 2) return { ok: false, msg: '❌ Nombre completo Ej: Cristian Castro' };
    return { ok: true, val: t };
  }
  if (tipo === 'telefono') {
    const num = t.replace(/\D/g, '').slice(-8);
    if (num.length !== 8 || !/^[67]/.test(num)) return { ok: false, msg: '❌ Tel 8 digitos Ej: 77974768' };
    return { ok: true, val: num };
  }
  if (tipo === 'departamento') {
    const found = DEPTOS.find(d => norm(d) === norm(t) || norm(d).includes(norm(t)));
    if (!found) return { ok: false, msg: `❌ Depto invalido. Elige: ${DEPTOS.join(', ')}` };
    return { ok: true, val: found };
  }
  if (tipo === 'municipio') {
    if (t.length < 3) return { ok: false, msg: '❌ Municipio muy corto' };
    return { ok: true, val: t };
  }
  if (tipo === 'direccion') {
    if (t.length < 10) return { ok: false, msg: '❌ Direccion corta Ej: Colonia X calle #12 frente a farmacia' };
    return { ok: true, val: t };
  }
  return { ok: true, val: t };
}

export async function GET() { return Response.json({ v: 'v16-prompts-separados' }); }

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
  let prod = searchOS(vars || [], raw);
  if (!prod && (intent === 'comprar' || intent === 'memoria') && state?.last_nombre) {
    prod = { nombre_completo: state.last_nombre, precio: state.last_precio, sku: state.last_sku, talla: state.last_talla, color: state.last_color };
  }

  let resp = '';
  if (intent === 'colectando') {
    const campo = state.paso.replace('collecting_', '');
    const v = validar(campo, raw);
    if (!v.ok) {
      resp = v.msg;
    } else {
      const col = campo === 'nombre' ? 'nombre_cliente' : campo === 'telefono' ? 'telefono_cliente' : campo;
      await supa.from('whatsapp_state').upsert({ telefono: jid, [col]: v.val, paso: 'idle' }, { onConflict: 'telefono' });
      resp = `✅ Anotado. Escribí "lo quiero" para seguir con *${state.last_nombre || 'tu pedido'}*`;
    }
  } else if (intent === 'comprar') {
    if (prod) await supa.from('whatsapp_state').upsert({ telefono: jid, last_sku: prod.sku, last_nombre: prod.nombre_completo, last_precio: prod.precio || 15, last_talla: prod.talla, last_color: prod.color }, { onConflict: 'telefono' });
    const falta = !state?.nombre_cliente ? 'nombre' : !state?.telefono_cliente ? 'telefono' : !state?.departamento ? 'departamento' : !state?.municipio ? 'municipio' : !state?.direccion ? 'direccion' : null;
    if (falta) {
      const msgs: any = { nombre: `1️⃣ Nombre completo Ej: Cristian Castro`, telefono: `2️⃣ Tel 8 digitos Ej: 77974768`, departamento: `3️⃣ Depto: ${DEPTOS.join(', ')}`, municipio: `4️⃣ Municipio Ej: Soyapango`, direccion: `5️⃣ Direccion exacta Ej: Colonia X #12 frente a` };
      await supa.from('whatsapp_state').upsert({ telefono: jid, paso: `collecting_${falta}` }, { onConflict: 'telefono' });
      resp = msgs[falta];
    } else {
      await supa.from('whatsapp_orders').insert({ telefono: jid, nombre: state.nombre_cliente, telefono_cliente: state.telefono_cliente, departamento: state.departamento, municipio: state.municipio, direccion: state.direccion, items: [prod], total: prod?.precio || 15, estado: 'nuevo' });
      resp = `✅ PEDIDO CONFIRMADO\n🛍️ ${prod?.nombre_completo}\n👤 ${state.nombre_cliente}\n📱 ${state.telefono_cliente}\n📍 ${state.departamento}, ${state.municipio}\n🏠 ${state.direccion}`;
    }
  } else if (intent === 'como_pedir') {
    resp = `Para pedir 🚚\n1. Decí producto\n2. Decí "lo quiero"\n3. Te pido datos completos\n4. Resumen`;
  } else {
    if (prod) {
      let precio = prod.precio || 15;
      if (!prod.precio && prod.template_id) {
        const { data: p } = await supa.from('productos').select('*').eq('id', prod.template_id).single();
        precio = p?.precio || p?.list_price || precio;
      }
      prod.precio = precio;
      await supa.from('whatsapp_state').upsert({ telefono: jid, last_sku: prod.sku, last_nombre: prod.nombre_completo, last_precio: precio }, { onConflict: 'telefono' });
      resp = `🛍️ *${prod.nombre_completo}*\n💰 $${precio}\n🎨 Talla: ${prod.talla || 'Única'} | Color: ${prod.color || 'Variado'}\n📦 Disponible ✅\n\n¿Te lo aparto? Escribe "lo quiero"`;
    } else {
      resp = `¡Hola! Tengo ${vars?.length || 0} productos. Escribe "porta bebes"`;
    }
  }

  await supa.from('whatsapp_conversations').insert({ telefono: jid, entrada: raw, respuesta: resp });
  await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`, { method: 'POST', headers: { 'apikey': process.env.EVOLUTION_API_KEY!, 'Content-Type': 'application/json' }, body: JSON.stringify({ number: jid, text: resp }) });
  return Response.json({ ok: true });
}
