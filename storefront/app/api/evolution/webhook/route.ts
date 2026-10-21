import { createClient } from '@supabase/supabase-js';

const norm = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const toks = (s: string) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);
const DEPTOS = ["Ahuachapan","Santa Ana","Sonsonate","Chalatenango","La Libertad","San Salvador","Cuscatlan","La Paz","Cabanas","San Vicente","Usulutan","San Miguel","Morazan","La Union"];
const getKey = (jid: string) => jid.split('@')[0].replace(/\D/g,'').slice(-11);

// ==================== SOLO CAMBIAS ESTO ====================
const CONFIG = {
  PRECIO_DEFECTO: 15,
  MENSAJE_SALUDO: `¡Hola! Tengo 91 productos. Escribe "porta bebes"`
};

// ==================== HELPER A PRUEBA DE DUPLICADOS ====================
async function getState(supa:any, phoneKey:string){
  const {data} = await supa.from('whatsapp_state').select('*').eq('telefono', phoneKey).limit(1).maybeSingle();
  return data;
}
async function saveState(supa:any, phoneKey:string, updates:any){
  const existing = await getState(supa, phoneKey);
  if(existing){
    await supa.from('whatsapp_state').update({...updates, updated_at: new Date().toISOString()}).eq('telefono', phoneKey);
  }else{
    await supa.from('whatsapp_state').insert({telefono: phoneKey, ...updates});
  }
}

// ==================== AGENTE 1: CLASIFICADOR ====================
function classifyIntent(raw:string, state:any){
  if(state?.paso?.startsWith('collecting_')) return 'colectando';
  const n = norm(raw);
  if(/lo quiero|apartalo/i.test(n)) return 'comprar';
  return 'buscar';
}

// ==================== AGENTE 2: BUSCADOR - NO TOCAR ====================
async function searchOS(vars:any[], raw:string){
  const q = toks(raw).filter(w=>!['quiero','informacion'].includes(w));
  if(!q.length) return null;
  const scored = vars.map((v:any)=>{
    const name = toks(v.nombre_completo||'');
    let s=0; for(const qq of q) if(name.includes(qq)) s+=30;
    if(raw.toLowerCase().includes('porta bebe') && name.includes('porta') && name.includes('bebe')) s+=100;
    return {...v,_score:s};
  }).filter((v:any)=>v._score>0).sort((a:any,b:any)=>b._score-a._score);
  return scored[0]||null;
}

// ==================== AGENTE 3: CHECKOUT ESTRICTO ====================
function validar(tipo:string, v:string){
  const t=v.trim();
  if(tipo==='nombre' && t.split(' ').filter(w=>w.length>=2).length<2) return {ok:false,msg:'❌ Nombre y apellido Ej: Juan Peña'};
  if(tipo==='telefono' && t.replace(/\D/g,'').length<8) return {ok:false,msg:'❌ 8 dígitos Ej: 77974768'};
  if(tipo==='departamento'){
    const f=DEPTOS.find(d=>norm(d).includes(norm(t)));
    if(!f) return {ok:false,msg:`❌ Depto: ${DEPTOS.join(', ')}`};
    return {ok:true,val:f};
  }
  if(tipo==='municipio' && t.length<3) return {ok:false,msg:'❌ Municipio corto'};
  if(tipo==='direccion' && t.length<10) return {ok:false,msg:'❌ Dirección corta Ej: Colonia X #12'};
  return {ok:true,val:t};
}

async function pedirSiguiente(supa:any, phoneKey:string){
  const state = await getState(supa, phoneKey);
  const falta = !state?.nombre_cliente?'nombre':!state?.telefono_cliente?'telefono':!state?.departamento?'departamento':!state?.municipio?'municipio':!state?.direccion?'direccion':null;
  if(!falta){
    await supa.from('whatsapp_orders').insert({telefono:phoneKey, nombre:state.nombre_cliente, telefono_cliente:state.telefono_cliente, departamento:state.departamento, municipio:state.municipio, direccion:state.direccion, items:[{nombre:state.last_nombre}], total:state.last_precio, estado:'nuevo'});
    await saveState(supa, phoneKey, {paso:'confirmado'});
    return `✅ PEDIDO CONFIRMADO\n🛍️ ${state.last_nombre}\n👤 ${state.nombre_cliente}\n📱 ${state.telefono_cliente}\n📍 ${state.departamento}, ${state.municipio}\n🏠 ${state.direccion}`;
  }else{
    const msgs:any={nombre:`1️⃣ Nombre completo Ej: Cristian Castro`, telefono:`2️⃣ Tel 8 dígitos Ej: 77974768`, departamento:`3️⃣ Departamento`, municipio:`4️⃣ Municipio Ej: Soyapango`, direccion:`5️⃣ Dirección exacta Ej: Colonia X #12 frente a farmacia`};
    await saveState(supa, phoneKey, {paso:`collecting_${falta}`});
    return msgs[falta];
  }
}

// ==================== AGENTE 4: LILI ====================
function formatLILI(prod:any){
  return `🛍️ *${prod.nombre_completo}*\n💰 $${prod.precio||15}\n🎨 Talla: ${prod.talla||'Unica'} | Color: ${prod.color||'Unica'}\n📦 Disponible ✅\n\n¿Te lo aparto? Escribe "lo quiero" 🚚`;
}

export async function GET(){return Response.json({v:'v20-predisenado-sin-onConflict'})}

export async function POST(req:Request){
  const body=await req.json(); const d=body.data||body;
  if(d.key?.fromMe) return Response.json({ok:true});
  const jid=d.key?.remoteJid||''; const raw=(d.message?.conversation||d.message?.extendedTextMessage?.text||'').trim();
  if(!raw||!jid) return Response.json({ok:true});
  const phoneKey=getKey(jid);

  const supa=createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
  const {data:vars}=await supa.from('productos_variantes').select('*').limit(3000);
  let state=await getState(supa, phoneKey);
  if(!state) state={telefono:phoneKey};

  const intent=classifyIntent(raw, state);
  let prod=null;
  if(intent!=='colectando'){
    prod=await searchOS(vars||[], raw);
    if(!prod && intent==='comprar' && state?.last_nombre) prod={nombre_completo:state.last_nombre, precio:state.last_precio};
  }

  let resp='';
  if(intent==='colectando'){
    const campo=state.paso.replace('collecting_','');
    const v=validar(campo, raw);
    if(!v.ok) resp=v.msg;
    else{
      const col=campo==='nombre'?'nombre_cliente':campo==='telefono'?'telefono_cliente':campo;
      await saveState(supa, phoneKey, {[col]:v.val});
      resp=await pedirSiguiente(supa, phoneKey);
    }
  }else if(intent==='comprar'){
    if(prod) await saveState(supa, phoneKey, {last_nombre:prod.nombre_completo, last_precio:prod.precio||15});
    resp=await pedirSiguiente(supa, phoneKey);
  }else{
    if(prod){
      await saveState(supa, phoneKey, {last_nombre:prod.nombre_completo, last_precio:prod.precio||15});
      resp=formatLILI(prod);
    }else resp=CONFIG.MENSAJE_SALUDO;
  }

  await supa.from('whatsapp_conversations').insert({telefono:phoneKey, entrada:raw, respuesta:resp});
  await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,{method:'POST',headers:{'apikey':process.env.EVOLUTION_API_KEY!,'Content-Type':'application/json'},body:JSON.stringify({number:jid,text:resp})});
  return Response.json({ok:true,intent,phoneKey});
}
