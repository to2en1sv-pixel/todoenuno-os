import { createClient } from '@supabase/supabase-js';
export async function GET(){return Response.json({v:'v10-fix-porta-vs-portable'})}
const norm=(s:string)=>(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();

function score(nombre:string, terms:string[]){
  const n=norm(nombre);
  let pts=0;
  const words=n.split(/[^a-z0-9]+/);
  for(const t of terms){
    if(n.includes(t)) pts+=10;
    if(words.includes(t)) pts+=20; // palabra exacta vale más
    if(t.length>4 && n.includes(t.slice(0,4))) pts+=5;
  }
  // bonus si contiene TODOS los terminos
  if(terms.length>=2 && terms.every(t=>n.includes(t))) pts+=50;
  return pts;
}

export async function POST(req:Request){
  const body=await req.json(); const d=body.data||body; if(d.key?.fromMe) return Response.json({ok:true});
  const remoteJid=d.key?.remoteJid||''; const raw=(d.message?.conversation||d.message?.extendedTextMessage?.text||'').trim();
  if(!raw||!remoteJid) return Response.json({ok:true});
  const supa=createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

  const {data:allVars}=await supa.from('productos_variantes').select('sku,nombre_completo,precio,producto_id').limit(3000);
  const search=norm(raw).replace(/[^a-z0-9 ]/g,' ').split(' ').filter(w=>w.length>=3 && !['quiero','informacion','info','productos','tienes','que','para','del','quiero','dame','mas'].includes(w));
  // normaliza plural bebes->bebe
  const terms=search.map(w=> w.endsWith('s')? w.slice(0,-1) : w).filter((v,i,a)=>a.indexOf(v)===i);
  
  let candidatos:any[]=[];
  if(allVars?.length && terms.length){
    candidatos=allVars.map(v=>({...v, _score: score(v.nombre_completo, terms)})).filter(v=>v._score>0).sort((a,b)=>b._score-a._score);
  }

  let prod=candidatos[0]||null;
  if(!prod && /porta.*bebe|bebe.*porta/i.test(norm(raw))){
    prod=allVars?.find(v=>norm(v.nombre_completo).includes('porta') && norm(v.nombre_completo).includes('bebe'))||null;
  }
  if(!prod && /urinario.*rana|rana.*urinario/i.test(norm(raw))){
    prod=allVars?.find(v=>norm(v.nombre_completo).includes('urinario') && norm(v.nombre_completo).includes('rana'))||null;
  }

  if(prod && !prod.precio && prod.producto_id){
    const {data:p}=await supa.from('productos').select('precio').eq('id',prod.producto_id).single();
    if(p?.precio) prod.precio=p.precio;
  }

  const {data:st}=await supa.from('whatsapp_state').select('*').eq('telefono',remoteJid).single();
  let state=st||{telefono:remoteJid};
  if(prod) await supa.from('whatsapp_state').upsert({telefono:remoteJid,last_sku:prod.sku,last_nombre:prod.nombre_completo,last_precio:prod.precio},{onConflict:'telefono'});

  const esQuiero=/lo quiero|apartalo/i.test(raw.toLowerCase());
  const falta=!state.nombre_cliente?'nombre':!state.telefono_cliente?'telefono':!state.departamento?'departamento':!state.municipio?'municipio':null;
  let resp='';

  if(esQuiero && (prod||state.last_nombre)){
    const p=prod||{nombre_completo:state.last_nombre,precio:state.last_precio};
    if(falta){
      resp=falta==='nombre'?`¡Perfecto! 🎉 *${p.nombre_completo}* $${p.precio} - Dime tu nombre completo`:falta==='telefono'?`Tu teléfono 📱`:falta==='departamento'?`¿Departamento?`:`¿Municipio?`;
      await supa.from('whatsapp_state').upsert({telefono:remoteJid,paso:`collecting_${falta}`},{onConflict:'telefono'});
    }else{
      await supa.from('whatsapp_orders').insert({telefono:remoteJid,nombre:state.nombre_cliente,telefono_cliente:state.telefono_cliente,departamento:state.departamento,municipio:state.municipio,items:[p],total:p.precio,estado:'nuevo'});
      resp=`✅ RESUMEN\n🛍️ ${p.nombre_completo}\n💰 $${p.precio}\n👤 ${state.nombre_cliente}\n📱 ${state.telefono_cliente}\n📍 ${state.departamento}, ${state.municipio}`;
    }
  }else if(state.paso?.startsWith('collecting_')){
    const campo=state.paso.replace('collecting_',''); const col=campo==='nombre'?'nombre_cliente':campo==='telefono'?'telefono_cliente':campo;
    await supa.from('whatsapp_state').upsert({telefono:remoteJid,[col]:raw},{onConflict:'telefono'});
    resp=`¡Anotado! Escribe "lo quiero" para confirmar`;
    await supa.from('whatsapp_state').upsert({telefono:remoteJid,paso:'idle'},{onConflict:'telefono'});
  }else{
    if(prod) resp=`🛍️ *${prod.nombre_completo}*\n💰 Precio: *$${prod.precio}*\n📦 Estado: *Disponible* ✅\n\n¿Te lo aparto? Escribe "lo quiero" 🚚`;
    else if(allVars?.length) resp=`¡Hola! 😊 Tengo ${allVars.length} productos en xpnz.\nEscribí "porta bebes" o "urinario rana"`;
    else resp=`¡Hola! Base vacía`;
  }

  console.log('SEARCH', raw, '-> terms', terms, '-> top', prod?.nombre_completo, 'score', candidatos[0]?._score);
  await supa.from('whatsapp_conversations').insert({telefono:remoteJid,entrada:raw,respuesta:resp});
  await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,{method:'POST',headers:{'apikey':process.env.EVOLUTION_API_KEY!,'Content-Type':'application/json'},body:JSON.stringify({number:remoteJid,text:resp})});
  return Response.json({ok:true});
}
