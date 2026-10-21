import { createClient } from '@supabase/supabase-js';
export const dynamic = 'force-dynamic';

const norm = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const toks = (s: string) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);
const DEPTOS = ["Ahuachapan","Santa Ana","Sonsonate","Chalatenango","La Libertad","San Salvador","Cuscatlan","La Paz","Cabanas","San Vicente","Usulutan","San Miguel","Morazan","La Union"];
const getKey = (jid: string) => jid.split('@')[0].replace(/[^0-9]/g,'').slice(-11);

const CONFIG = {
  SALUDO: "Hola! Tengo 91 productos. Escribe porta bebes",
  PRECIO_DEFECTO: 15
};

async function getState(supa: any, k: string) {
  const res = await supa.from('whatsapp_state').select('*').eq('telefono', k).limit(1).maybeSingle();
  return res.data;
}

async function saveState(supa: any, k: string, updates: any) {
  const existing = await getState(supa, k);
  const merged = { ...(existing || {}), ...updates, telefono: k };
  await supa.from('whatsapp_state').delete().eq('telefono', k);
  await supa.from('whatsapp_state').insert(merged);
}

function esProductoReal(raw: string, vars: any[]) {
  if (!vars || vars.length === 0) return false;
  const n = norm(raw);
  if (n.length < 4) return false;
  for (const v of vars) {
    const nombre = norm(v.nombre_completo || '');
    if (nombre.includes(n) || n.includes(nombre.split(' ')[0])) {
      return true;
    }
  }
  return false;
}

function validarSegunEntidad(entidad: string, valor: string) {
  const t = valor.trim();
  if (entidad === 'PERSONA') {
    if (t.length < 2) {
      return { ok: false, msg: "Dame tu nombre Ej: Carlos Sorto" };
    }
    return { ok: true, val: t };
  }
  if (entidad === 'TELEFONO') {
    const num = t.replace(/[^0-9]/g,'').slice(-8);
    if (num.length < 8) {
      return { ok: false, msg: "8 digitos Ej: 77974768" };
    }
    return { ok: true, val: num };
  }
  if (entidad === 'DEPARTAMENTO') {
    const f = DEPTOS.find(d => norm(d).includes(norm(t)) || norm(t).includes(norm(d)));
    if (!f) {
      return { ok: false, msg: "Depto: " + DEPTOS.join(', ') };
    }
    return { ok: true, val: f };
  }
  if (entidad === 'MUNICIPIO') {
    if (t.length < 3) {
      return { ok: false, msg: "Municipio corto Ej: Soyapango" };
    }
    return { ok: true, val: t };
  }
  if (entidad === 'DIRECCION') {
    if (t.length < 8) {
      return { ok: false, msg: "Direccion corta Ej: Colonia Escalon #12" };
    }
    return { ok: true, val: t };
  }
  return { ok: true, val: t };
}

function classifyIntent(raw: string, state: any, vars: any[]) {
  if (state && state.paso && state.paso.startsWith('collecting_')) {
    return 'colectando';
  }
  const n = norm(raw);
  if (n.includes('lo quiero') || n.includes('apartalo')) {
    return 'comprar';
  }
  if (esProductoReal(raw, vars)) {
    return 'buscar';
  }
  return 'charla';
}

async function searchOS(vars: any[], raw: string) {
  const n = norm(raw);
  const q = toks(raw).filter(w => w !== 'quiero' && w !== 'informacion');
  if (q.length === 0) return null;
  const scored = vars.map((v: any) => {
    const name = toks(v.nombre_completo || '');
    let s = 0;
    for (const qq of q) {
      if (name.includes(qq)) s += 30;
    }
    if (n.includes('porta bebe') && name.includes('porta') && name.includes('bebe')) {
      s += 100;
    }
    return { ...v, _score: s };
  }).filter((v: any) => v._score > 0).sort((a: any, b: any) => b._score - a._score);
  return scored[0] || null;
}

async function pedirSiguiente(supa: any, k: string) {
  const state = await getState(supa, k);
  const falta = !state?.nombre_cliente ? 'nombre' : !state?.telefono_cliente ? 'telefono' : !state?.departamento ? 'departamento' : !state?.municipio ? 'municipio' : !state?.direccion ? 'direccion' : null;
  if (!falta) {
    await supa.from('whatsapp_orders').insert({
      telefono: k,
      nombre: state.nombre_cliente,
      telefono_cliente: state.telefono_cliente,
      departamento: state.departamento,
      municipio: state.municipio,
      direccion: state.direccion,
      items: [{ nombre: state.last_nombre }],
      total: state.last_precio || CONFIG.PRECIO_DEFECTO,
      estado: 'nuevo'
    });
    await saveState(supa, k, { paso: 'confirmado' });
    return "PEDIDO CONFIRMADO\n" + state.last_nombre + "\n" + state.nombre_cliente + "\n" + state.telefono_cliente + "\n" + state.departamento + ", " + state.municipio + "\n" + state.direccion;
  } else {
    const msgs: any = {
      nombre: "1 Nombre completo Ej: Cristian Castro",
      telefono: "2 Tel 8 digitos Ej: 77974768",
      departamento: "3 Departamento",
      municipio: "4 Municipio Ej: Soyapango",
      direccion: "5 Direccion exacta Ej: Colonia Escalon #12"
    };
    await saveState(supa, k, { paso: "collecting_" + falta });
    return msgs[falta];
  }
}

function formatLILI(prod: any) {
  return "PORTA BEBES\n$" + (prod.precio || 15) + "\nTalla: " + (prod.talla || 'Unica') + " | Color: " + (prod.color || 'Unica') + "\nDisponible\n\nTe lo aparto? Escribe lo quiero";
}

export async function GET() {
  return Response.json({ v: 'v23-fix-eof' });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const d = body.data || body;
    if (d.key?.fromMe) return Response.json({ ok: true });
    const jid = d.key?.remoteJid || '';
    const raw = (d.message?.conversation || d.message?.extendedTextMessage?.text || '').trim();
    if (!raw || !jid) return Response.json({ ok: true });
    const k = getKey(jid);

    const supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
    const resVars = await supa.from('productos_variantes').select('*').limit(3000);
    const vars = resVars.data || [];

    let state = await getState(supa, k);
    if (!state) state = { telefono: k };

    const intent = classifyIntent(raw, state, vars);
    let resp = '';

    if (intent === 'colectando') {
      const campo = state.paso.replace('collecting_', '');
      const entidad = campo === 'nombre' ? 'PERSONA' : campo === 'telefono' ? 'TELEFONO' : campo === 'departamento' ? 'DEPARTAMENTO' : campo === 'municipio' ? 'MUNICIPIO' : 'DIRECCION';
      const v = validarSegunEntidad(entidad, raw);
      if (!v.ok) {
        resp = v.msg;
      } else {
        const col = campo === 'nombre' ? 'nombre_cliente' : campo === 'telefono' ? 'telefono_cliente' : campo;
        const obj: any = {};
        obj[col] = v.val;
        await saveState(supa, k, obj);
        resp = await pedirSiguiente(supa, k);
      }
    } else if (intent === 'comprar') {
      const prod = await searchOS(vars, state?.last_nombre || 'porta bebes');
      const finalProd = prod || { nombre_completo: state?.last_nombre || 'PORTA BEBES', precio: state?.last_precio || CONFIG.PRECIO_DEFECTO };
      await saveState(supa, k, { last_nombre: finalProd.nombre_completo, last_precio: finalProd.precio || CONFIG.PRECIO_DEFECTO });
      resp = await pedirSiguiente(supa, k);
    } else if (intent === 'buscar') {
      const prod = await searchOS(vars, raw);
      if (prod) {
        await saveState(supa, k, { last_nombre: prod.nombre_completo, last_precio: prod.precio || CONFIG.PRECIO_DEFECTO });
        resp = formatLILI(prod);
      } else {
        resp = CONFIG.SALUDO;
      }
    } else {
      resp = await pedirSiguiente(supa, k);
    }

    await supa.from('whatsapp_conversations').insert({ telefono: k, entrada: raw, respuesta: resp });
    await fetch(process.env.EVOLUTION_API_URL + "/message/sendText/" + process.env.EVOLUTION_INSTANCE, {
      method: 'POST',
      headers: { 'apikey': process.env.EVOLUTION_API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: jid, text: resp })
    });

    return Response.json({ ok: true, intent });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
