import { createClient } from '@supabase/supabase-js';

const norm = (s:string)=>(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const toks = (s:string)=>norm(s).split(/[^a-z0-9]+/).filter(Boolean);
const DEPTOS = ["Ahuachapan","Santa Ana","Sonsonate","Chalatenango","La Libertad","San Salvador","Cuscatlan","La Paz","Cabanas","San Vicente","Usulutan","San Miguel","Morazan","La Union"];
const getKey = (jid:string)=>jid.split('@')[0].replace(/\D/g,'').slice(-11);

// ==================== CONFIG - SOLO CAMBIAS ESTO ====================
const CONFIG = {
  PRECIO: 15,
  SALUDO: `¡Hola! Tengo 91 productos. Escribe "porta bebes"`
};

// ==================== DB HELPER ANTI-LOOP ====================
async function getState(supa:any, k:string){
  const {data}=await supa.from('whatsapp_state').select('*').eq('telefono',k).limit(1).maybeSingle();
  return data;
}
async function saveState(supa:any, k:string, updates:any){
  const existing = await getState(supa,k);
  const merged = {...(existing||{}), ...updates, telefono:k, updated_at: new Date().toISOString()};
  await supa.from('whatsapp_state').delete().eq('telefono',k); // borra duplicados
  await supa.from('whatsapp_state').insert(merged);
}

// ==================== AGENTE 1: CLASIFICADOR - INICIO ====================
function classifyIntent(raw:string, state:any){
  if(state?.paso?.startsWith('collecting_')) return 'colectando';
  const n=norm(raw);
  if(/lo quiero|apartalo/i.test(n)) return 'comprar';
  return 'buscar';
}
// ==================== AGENTE 1: FIN ====================

// ==================== AGENTE 1.5: LISTA BLANCA DE PRODUCTOS - INICIO ====================
function esProductoReal(raw:string, vars:any[]){
  const n = norm(raw);
  // solo si el mensaje contiene alguna palabra de tus productos
  const keywords = vars.map(v=> norm(v.nombre_completo).split(' ').slice(0,2).join(' ')); // ej "porta bebe", "urinario rana", "cangurera urbana"
  return keywords.some(k => n.includes(k) || k.includes(n) && n.length>4);
}

function classifyIntent(raw:string, state:any, vars:any[]){
  // FIX PRINCIPAL: si está recolectando, NUNCA es búsqueda
  if(state?.paso?.startsWith('collecting_')) return 'colectando';
  const n = norm(raw);
  if(/lo quiero|apartalo/i.test(n)) return 'comprar';
  // Solo es buscar si realmente menciona un producto de la lista blanca
  if(esProductoReal(raw, vars)) return 'buscar';
  return 'charla'; // asistente de ventas, no consultor de BD
}
// ==================== AGENTE 1.5: FIN ====================

// En el POST reemplaza la lógica final por esto:
let state = await getState(supa, k);
let intent = classifyIntent(raw, state, vars||[]);
let prod = null;

if(intent==='colectando'){
  const campo = state.paso.replace('collecting_','');
  const entidad = campo==='nombre'?'PERSONA':campo==='direccion'?'DIRECCION':campo.toUpperCase();
  const v = validarSegunEntidad(entidad, raw);
  if(!v.ok) resp=v.msg;
  else{
    const col=campo==='nombre'?'nombre_cliente':campo==='telefono'?'telefono_cliente':campo;
    await saveState(supa,k,{[col]:v.val});
    resp=await pedirSiguiente(supa,k);
  }
}else if(intent==='comprar'){
  // ... igual
}else if(intent==='buscar'){
  prod=await searchOS(vars||[], raw);
  if(prod){
    await saveState(supa,k,{last_nombre:prod.nombre_completo,last_precio:prod.precio||15});
    resp=formatLILI(prod);
  }
}else{
  // intent charla = asistente de ventas, no vuelve al saludo
  resp=`Perfecto ${state?.nombre_cliente||''} 👌 seguimos con tu pedido de *${state?.last_nombre||'PORTA BEBES'}*.\n${await pedirSiguiente(supa,k)}`;
}

// ==================== AGENTE 2: BUSCADOR - INICIO ====================
async function searchOS(vars:any[], raw:string){
  const q=toks(raw).filter(w=>!['quiero'].includes(w));
  if(!q.length) return null;
  const scored=vars.map((v:any)=>{
    const name=toks(v.nombre_completo||'');
    let s=0; for(const qq of q) if(name.includes(qq)) s+=30;
    if(norm(raw).includes('porta bebe') && name.includes('porta') && name.includes('bebe')) s+=100;
    return {...v,_score:s};
  }).filter((v:any)=>v._score>0).sort((a:any,b:any)=>b._score-a._score);
  return scored[0]||null;
}
// ==================== AGENTE 2: FIN ====================

// ==================== AGENTE 3: CHECKOUT ESTRICTO - INICIO ====================
async function pedirSiguiente(supa:any, k:string){
  const state=await getState(supa,k);
  const falta=!state?.nombre_cliente?'nombre':!state?.telefono_cliente?'telefono':!state?.departamento?'departamento':!state?.municipio?'municipio':!state?.direccion?'direccion':null;
  if(!falta){
    await supa.from('whatsapp_orders').insert({telefono:k, nombre:state.nombre_cliente, telefono_cliente:state.telefono_cliente, departamento:state.departamento, municipio:state.municipio, direccion:state.direccion, items:[{nombre:state.last_nombre}], total:state.last_precio, estado:'nuevo'});
    await saveState(supa,k,{paso:'confirmado'});
    return `✅ PEDIDO CONFIRMADO\n🛍️ ${state.last_nombre}\n👤 ${state.nombre_cliente}\n📱 ${state.telefono_cliente}\n📍 ${state.departamento}, ${state.municipio}\n🏠 ${state.direccion}`;
  }else{
    const msgs:any={nombre:`1️⃣ Nombre completo Ej: Cristian Castro`, telefono:`2️⃣ Tel 8 dígitos`, departamento:`3️⃣ Departamento`, municipio:`4️⃣ Municipio`, direccion:`5️⃣ Dirección exacta`};
    await saveState(supa,k,{paso:`collecting_${falta}`});
    return msgs[falta];
  }
}
// ==================== AGENTE 3: FIN ====================

// ==================== AGENTE 4: LILI - INICIO ====================
function formatLILI(prod:any){
  return `🛍️ *${prod.nombre_completo}*\n💰 $${prod.precio||15}\n🎨 Talla: Unica | Color: Unica\n📦 Disponible ✅\n\n¿Te lo aparto? Escribe "lo quiero" 🚚`;
}
// ==================== AGENTE 4: FIN ====================

export async function GET(){return Response.json({v:'v21-agente-1.5-distingue'})}
export async function POST(req:Request){
  const b=await req.json(); const d=b.data||b;
  if(d.key?.fromMe) return Response.json({ok:true});
  const jid=d.key?.remoteJid||''; const raw=(d.message?.conversation||d.message?.extendedTextMessage?.text||'').trim();
  if(!raw||!jid) return Response.json({ok:true});
  const k=getKey(jid);

  const supa=createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
  const {data:vars}=await supa.from('productos_variantes').select('*').limit(3000);
  let state=await getState(supa,k);
  if(!state) state={telefono:k};

  const intent=classifyIntent(raw, state);
  let resp='';

  if(intent==='colectando'){
    const pasoActual=state.paso;
    const entidad=distinguirEntidad(raw, pasoActual);
    const v=validarSegunEntidad(entidad, raw);
    if(!v.ok) resp=v.msg;
    else{
      const campo=pasoActual.replace('collecting_','');
      const col=campo==='nombre'?'nombre_cliente':campo==='telefono'?'telefono_cliente':campo;
      await saveState(supa,k,{[col]:v.val});
      resp=await pedirSiguiente(supa,k);
    }
  }else if(intent==='comprar'){
    const prod=await searchOS(vars||[], raw) || (state?.last_nombre?{nombre_completo:state.last_nombre,precio:state.last_precio}:null);
    if(prod) await saveState(supa,k,{last_nombre:prod.nombre_completo,last_precio:prod.precio||15});
    resp=await pedirSiguiente(supa,k);
  }else{
    const prod=await searchOS(vars||[], raw);
    if(prod){
      await saveState(supa,k,{last_nombre:prod.nombre_completo,last_precio:prod.precio||15});
      resp=formatLILI(prod);
    }else resp=CONFIG.SALUDO;
  }

  await supa.from('whatsapp_conversations').insert({telefono:k, entrada:raw, respuesta:resp});
  await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,{method:'POST',headers:{'apikey':process.env.EVOLUTION_API_KEY!,'Content-Type':'application/json'},body:JSON.stringify({number:jid,text:resp})});
  return Response.json({ok:true,intent});
}
