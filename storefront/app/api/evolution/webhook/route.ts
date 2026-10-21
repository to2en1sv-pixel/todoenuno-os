import { createClient } from '@supabase/supabase-js';
export async function GET(){return Response.json({v:'v14-4-agentes', db:'xpnz', repo:'todoenuno-os'})}

const norm=(s:string)=>(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const toks=(s:string)=>norm(s).split(/[^a-z0-9]+/).filter(Boolean);

// AGENTE 1: Clasificador - 0 LLM, 15 líneas
function classifyIntent(raw:string, state:any){
  const n=norm(raw);
  if(/lo quiero|apartalo|quiero ese|si lo quiero/.test(n)) return 'comprar';
  if(/como.*pido|como.*pedido|como.*ordeno|como.*compro/.test(n)) return 'como_pedir';
  if(/recuerdas|por cual|que.*pregunte|ultimo.*producto/.test(n)) return 'memoria';
  if(state?.paso?.startsWith('collecting_')) return 'colectando';
  if(toks(raw).length>=1) return 'buscar';
  return 'saludo';
}

// AGENTE 2: Buscador OS - 0 LLM, solo SQL + scoring, no inventa
function searchOS(vars:any[], raw:string){
  if(!vars?.length) return {prod:null, all:[]};
  const q=toks(raw).filter(w=>!['quiero','informacion','del','para','hola','mas','quiero'].includes(w));
  if(!q.length) return {prod:null, all:[]};

  const scored=vars.map(v=>{
    const name=toks(v.nombre_completo||'');
    let s=0;
    for(const qq of q){
      const isBebe = (qq==='bebes'||qq==='bebe') && name.some(t=>t.startsWith('bebe'));
      if(name.includes(qq) || isBebe) s+=30;
      if(qq==='porta' && name.includes('porta') && !name.includes('portable')) s+=50; // evita Bocina X-312 Portable
      if(qq==='porta' && name.includes('portable')) s-=40;
      if(qq==='rana' && name.includes('rana')) s+=40;
      if(qq==='urinario' && name.includes('urinario')) s+=40;
    }
    if(q.length>=2 && q.every(x=> name.includes(x) || (x==='bebes'&&name.includes('bebe')) || name.some(t=>t.startsWith(x.slice(0,4))))) s+=70;
    return {...v, _score:s, _nameT:name};
  }).filter(v=>v._score>0).sort((a,b)=>b._score-a._score);

  // fixes directos para tus 2 productos clave
  let prod=scored[0]||null;
  if(!prod && /porta.*bebe/i.test(norm(raw))) prod=vars.find(v=>norm(v.nombre_completo).includes('porta') && norm(v.nombre_completo).includes('bebe'))||null;
  if(!prod && /urinario/i.test(norm(raw))) prod=vars.find(v=>norm(v.nombre_completo).includes('urinario'))||null;
  
  return {prod, all:scored};
}

// AGENTE 3: Checkout - 0 LLM, máquina determinista
async function checkoutFlow(supa:any, state:any, prod:any, raw:string, jid:string){
  const falta=!state?.nombre_cliente?'nombre':!state?.telefono_cliente?'telefono':!state?.departamento?'departamento':!state?.municipio?'municipio':null;
  const p=prod||{nombre_completo:state?.last_nombre, precio:state?.last_precio, sku:state?.last_sku};

  if(falta){
    const msgs:any={
      nombre:`¡Perfecto! 🎉 *${p.nombre_completo}* $${p.precio}\nPara apartarlo dime tu *nombre completo* ✨`,
      telefono:`¡Gracias ${state?.nombre_cliente||''}! ✅ Ahora tu *número de teléfono* 📱`,
      departamento:`¿De qué *departamento* sos? Ej: San Salvador`,
      municipio:`¿Y tu *municipio*? Ej: Soyapango`
    };
    await supa.from('whatsapp_state').upsert({telefono:jid,paso:`collecting_${falta}`},{onConflict:'telefono'});
    return msgs[falta];
  }else{
    await supa.from('whatsapp_orders').insert({telefono:jid,nombre:state.nombre_cliente,telefono_cliente:state.telefono_cliente,departamento:state.departamento,municipio:state.municipio,items:[p],total:p.precio,estado:'nuevo'});
    await supa.from('whatsapp_state').upsert({telefono:jid,paso:'confirmado'},{onConflict:'telefono'});
    return `✅ *RESUMEN DE TU PEDIDO* ✅\n\n🛍️ *${p.nombre_completo}*\n💰 *$${p.precio}*\n👤 ${state.nombre_cliente}\n📱 ${state.telefono_cliente}\n📍 ${state.departamento}, ${state.municipio}\n\n🚚 Entrega 3-5 días 🎉`;
  }
}

// AGENTE 4: LILI Vendedora - SOLO formatea, no busca
async function formatLILI(prod:any, intent:string, raw:string, state:any){
  if(intent==='como_pedir'){
    return `¡Claro! Para pedir es así 🚚\n\n1️⃣ Decime el producto Ej: "porta bebes"\n2️⃣ Decime "lo quiero"\n3️⃣ Te pido nombre, teléfono, depto y municipio\n4️⃣ Te mando resumen y lo apartamos ✅`;
  }
  if(intent==='memoria'){
    return `¡Claro que recuerdo! Me preguntaste por *${state?.last_nombre||'Porta Bebes'}* 💰 *$${state?.last_precio||15}*`;
  }
  if(!prod) return null;

  // si hay OPENAI_KEY usa GPT-4o solo para embellecer, si no usa plantilla
  if(process.env.OPENAI_API_KEY){
    try{
      const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-4o-mini',temperature:0.2,messages:[{role:'system',content:`Eres LILI de TodoEnUno. Formatea bonito este producto: ${prod.nombre_completo} $${prod.precio||prod.list_price||15}. Usa 🛍️ 💰 📦 ✅ 🚚 y *negritas*. Nunca digas sin stock. Respuesta corta.`},{role:'user',content:raw}]})});
      const j:any=await r.json();
      if(j.choices?.[0]?.message?.content) return j.choices[0].message.content;
    }catch{}
  }
  return `🛍️ *${prod.nombre_completo}*\n💰 Precio: *$${prod.precio||15}*\n📦 Estado: *Disponible* ✅\n\n¿Te lo aparto? Escribime "lo quiero" 🚚`;
}

export async function POST(req:Request){
  const b=await req.json(); const d=b.data||b; if(d.key?.fromMe) return Response.json({ok:true});
  const jid=d.key?.remoteJid||''; const raw=(d.message?.conversation||d.message?.extendedTextMessage?.text||'').trim();
  if(!raw||!jid) return Response.json({ok:true});
  const supa=createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

  const {data:vars, error}=await supa.from('productos_variantes').select('*').limit(3000);
  console.log('V14 vars', vars?.length, 'err', error?.message, 'raw', raw);
  const {data:st}=await supa.from('whatsapp_state').select('*').eq('telefono',jid).single();
  let state=st||{telefono:jid};

  const intent=classifyIntent(raw, state);
  const {prod:found}=searchOS(vars||[], raw);
  let prod=found;

  // si es comprar y no encontró, usa memoria
  if(!prod && (intent==='comprar'||intent==='memoria') && state?.last_nombre){
    prod={sku:state.last_sku, nombre_completo:state.last_nombre, precio:state.last_precio};
  }

  let resp='';
  if(intent==='colectando'){
    const campo=state.paso.replace('collecting_',''); const col=campo==='nombre'?'nombre_cliente':campo==='telefono'?'telefono_cliente':campo;
    await supa.from('whatsapp_state').upsert({telefono:jid,[col]:raw},{onConflict:'telefono'});
    const {data:st2}=await supa.from('whatsapp_state').select('*').eq('telefono',jid).single();
    state=st2; resp=`¡Anotado! Ahora escribime "lo quiero" para confirmar *${state.last_nombre||'tu producto'}*`;
    await supa.from('whatsapp_state').upsert({telefono:jid,paso:'idle'},{onConflict:'telefono'});
  }else if(intent==='comprar'){
    if(prod) await supa.from('whatsapp_state').upsert({telefono:jid,last_sku:prod.sku,last_nombre:prod.nombre_completo,last_precio:prod.precio||15},{onConflict:'telefono'});
    resp=await checkoutFlow(supa, state, prod, raw, jid);
  }else{
    if(prod){
      // trae precio real de productos vía template_id si no tiene
      let precio=prod.precio||prod.list_price||state?.last_precio||15;
      if(!prod.precio && prod.template_id){
        const {data:p}=await supa.from('productos').select('*').eq('id', prod.template_id).single();
        precio=p?.precio||p?.list_price||precio;
      }
      prod.precio=precio;
      await supa.from('whatsapp_state').upsert({telefono:jid,last_sku:prod.sku,last_nombre:prod.nombre_completo,last_precio:precio},{onConflict:'telefono'});
      resp=(await formatLILI(prod, intent, raw, state))||`🛍️ *${prod.nombre_completo}* $${precio}`;
    }else{
      resp=await formatLILI(null, intent, raw, state);
      if(!resp) resp=vars?.length?`¡Hola! 😊 Tengo ${vars.length} productos en xpnz. Escribí "porta bebes" o "urinario rana"`:`¡Hola! Base vacía`;
    }
  }

  await supa.from('whatsapp_conversations').insert({telefono:jid,entrada:raw,respuesta:resp});
  await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,{method:'POST',headers:{'apikey':process.env.EVOLUTION_API_KEY!,'Content-Type':'application/json'},body:JSON.stringify({number:jid,text:resp})});
  return Response.json({ok:true, intent, prod:prod?.nombre_completo});
}rom('whatsapp_conversations').insert({telefono:jid,entrada:raw,respuesta:resp});
  await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,{method:'POST',headers:{'apikey':process.env.EVOLUTION_API_KEY!,'Content-Type':'application/json'},body:JSON.stringify({number:jid,text:resp})});
  return Response.json({ok:true});
}
