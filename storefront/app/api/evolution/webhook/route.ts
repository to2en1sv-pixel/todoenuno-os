import { createClient } from '@supabase/supabase-js';
export async function GET(){return Response.json({v:'v14-4-agentes-fixed'})}
const norm=(s:string)=>(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const toks=(s:string)=>norm(s).split(/[^a-z0-9]+/).filter(Boolean);

function classifyIntent(raw:string, state:any){
  const n=norm(raw);
  if(/lo quiero|apartalo|quiero ese/i.test(n)) return 'comprar';
  if(/como.*pido|como.*pedido|como.*compro/.test(n)) return 'como_pedir';
  if(/recuerdas|por cual|que.*pregunte/.test(n)) return 'memoria';
  if(state?.paso?.startsWith('collecting_')) return 'colectando';
  return 'buscar';
}

function searchOS(vars:any[], raw:string){
  if(!vars?.length) return {prod:null, all:[]};
  const q=toks(raw).filter(w=>!['quiero','informacion','del','para','hola'].includes(w));
  const scored=vars.map(v=>{
    const name=toks(v.nombre_completo||'');
    let s=0;
    for(const qq of q){
      if(name.includes(qq)) s+=30;
      if((qq==='bebes'||qq==='bebe') && name.some(t=>t.startsWith('bebe'))) s+=30;
      if(qq==='porta' && name.includes('porta') && !name.includes('portable')) s+=50;
      if(qq==='porta' && name.includes('portable')) s-=40;
    }
    if(q.length>=2 && q.every(x=> name.includes(x) || (x==='bebes'&&name.includes('bebe')))) s+=60;
    return {...v, _score:s};
  }).filter(v=>v._score>0).sort((a,b)=>b._score-a._score);
  let prod=scored[0]||null;
  if(!prod && /porta.*bebe/i.test(norm(raw))) prod=vars.find(v=>norm(v.nombre_completo).includes('porta') && norm(v.nombre_completo).includes('bebe'))||null;
  if(!prod && /urinario/i.test(norm(raw))) prod=vars.find(v=>norm(v.nombre_completo).includes('urinario'))||null;
  return {prod, all:scored};
}

async function checkoutFlow(supa:any, state:any, prod:any, jid:string){
  const falta=!state?.nombre_cliente?'nombre':!state?.telefono_cliente?'telefono':!state?.departamento?'departamento':!state?.municipio?'municipio':null;
  const p=prod||{nombre_completo:state?.last_nombre, precio:state?.last_precio};
  if(falta){
    const msgs:any={
      nombre:`¡Perfecto! *${p.nombre_completo}* $${p.precio} - Dime tu nombre completo ✨`,
      telefono:`¡Gracias! Ahora tu número 📱`,
      departamento:`¿Departamento?`,
      municipio:`¿Municipio?`
    };
    await supa.from('whatsapp_state').upsert({telefono:jid,paso:`collecting_${falta}`},{onConflict:'telefono'});
    return msgs[falta];
  }else{
    await supa.from('whatsapp_orders').insert({telefono:jid,nombre:state.nombre_cliente,telefono_cliente:state.telefono_cliente,departamento:state.departamento,municipio:state.municipio,items:[p],total:p.precio,estado:'nuevo'});
    await supa.from('whatsapp_state').upsert({telefono:jid,paso:'confirmado'},{onConflict:'telefono'});
    return `✅ RESUMEN\n🛍️ ${p.nombre_completo}\n💰 $${p.precio}\n👤 ${state.nombre_cliente}\n📱 ${state.telefono_cliente}\n📍 ${state.departamento}, ${state.municipio}`;
  }
}

export async function POST(req:Request){
  const b=await req.json(); const d=b.data||b; if(d.key?.fromMe) return Response.json({ok:true});
  const jid=d.key?.remoteJid||''; const raw=(d.message?.conversation||d.message?.extendedTextMessage?.text||'').trim();
  if(!raw||!jid) return Response.json({ok:true});
  const supa=createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
  const {data:vars, error}=await supa.from('productos_variantes').select('*').limit(3000);
  const {data:st}=await supa.from('whatsapp_state').select('*').eq('telefono',jid).single();
  let state=st||{telefono:jid};
  const intent=classifyIntent(raw, state);
  const {prod:found}=searchOS(vars||[], raw);
  let prod=found;
  if(!prod && (intent==='comprar'||intent==='memoria') && state?.last_nombre) prod={sku:state.last_sku, nombre_completo:state.last_nombre, precio:state.last_precio};

  let resp='';
  if(intent==='colectando'){
    const campo=state.paso.replace('collecting_',''); const col=campo==='nombre'?'nombre_cliente':campo==='telefono'?'telefono_cliente':campo;
    await supa.from('whatsapp_state').upsert({telefono:jid,[col]:raw},{onConflict:'telefono'});
    resp=`¡Anotado! Escribe "lo quiero" para confirmar *${state.last_nombre||'tu producto'}*`;
    await supa.from('whatsapp_state').upsert({telefono:jid,paso:'idle'},{onConflict:'telefono'});
  }else if(intent==='comprar'){
    if(prod) await supa.from('whatsapp_state').upsert({telefono:jid,last_sku:prod.sku,last_nombre:prod.nombre_completo,last_precio:prod.precio||15},{onConflict:'telefono'});
    resp=await checkoutFlow(supa, state, prod, jid);
  }else if(intent==='como_pedir'){
    resp=`Para pedir 🚚\n1️⃣ Decime producto Ej: "porta bebes"\n2️⃣ Decime "lo quiero"\n3️⃣ Te pido datos\n4️⃣ Te mando resumen`;
  }else{
    if(prod){
      let precio=prod.precio||15;
      if(!prod.precio && prod.template_id){
        const {data:p}=await supa.from('productos').select('*').eq('id', prod.template_id).single();
        precio=p?.precio||p?.list_price||precio;
      }
      prod.precio=precio;
      await supa.from('whatsapp_state').upsert({telefono:jid,last_sku:prod.sku,last_nombre:prod.nombre_completo,last_precio:precio},{onConflict:'telefono'});
      resp=`🛍️ *${prod.nombre_completo}*\n💰 Precio: *$${precio}*\n📦 Disponible ✅\n\n¿Te lo aparto? Escribe "lo quiero" 🚚`;
    }else{
      resp=vars?.length?`¡Hola! Tengo ${vars.length} productos. Escribe "porta bebes" o "urinario rana"`: `¡Hola! Base vacía`;
    }
  }

  await supa.from('whatsapp_conversations').insert({telefono:jid,entrada:raw,respuesta:resp});
  await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,{method:'POST',headers:{'apikey':process.env.EVOLUTION_API_KEY!,'Content-Type':'application/json'},body:JSON.stringify({number:jid,text:resp})});
  return Response.json({ok:true, intent, prod:prod?.nombre_completo});
}
