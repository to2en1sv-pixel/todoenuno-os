import { createClient } from '@supabase/supabase-js';
export async function GET(){return Response.json({status:'ok',v:'v6-keywords'})}

function keywords(text:string){
  return text.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // quita tildes
    .replace(/[^a-z0-9 ]/g,' ')
    .split(' ')
    .filter(w=>w.length>2)
    .filter(w=>!['quiero','mas','mas','informacion','info','sobre','del','de','la','el','un','una','para','como','hola','quiero','dame','tienes'].includes(w));
}

export async function POST(req:Request){
 const body=await req.json();const d=body.data||body;if((d.key||{}).fromMe)return Response.json({ok:true});
 const remoteJid=(d.key||{}).remoteJid||'';const rawText=(d.message?.conversation||d.message?.extendedTextMessage?.text||'').trim();
 if(!rawText||!remoteJid)return Response.json({ok:true});
 const supa=createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_SERVICE_KEY!);

 const {data:st}=await supa.from('whatsapp_state').select('*').eq('telefono',remoteJid).single();
 let state=st||{telefono:remoteJid,paso:'idle'};
 const kws=keywords(rawText);
 const esQuiero=/lo quiero|apartalo/i.test(rawText.toLowerCase()) && rawText.length<25;
 const esPreguntaMemoria=/recuerdas|por cual/i.test(rawText.toLowerCase());

 let textoBusqueda=rawText;
 if((esQuiero || esPreguntaMemoria) && state.last_nombre) textoBusqueda=state.last_nombre;
 const searchWords=keywords(textoBusqueda);

 // BUSQUEDA ROBUSTA OR
 let prod:any=null;
 if(searchWords.length){
   const orQuery=searchWords.map(w=>`nombre_completo.ilike.%${w}%`).join(',');
   const {data:vars}=await supa.from('productos_variantes').select('sku,nombre_completo,precio,producto_id').or(orQuery).limit(5);
   if(vars?.length){
     for(const v of vars){ if(!v.precio && v.producto_id){ const {data:p}=await supa.from('productos').select('precio').eq('id',v.producto_id).single(); if(p?.precio) v.precio=p.precio; } }
     prod=vars.find(v=>v.precio) || vars[0];
     await supa.from('whatsapp_state').upsert({telefono:remoteJid,last_sku:prod.sku,last_nombre:prod.nombre_completo,last_precio:prod.precio,updated_at:new Date().toISOString()}, {onConflict:'telefono'});
   }
 }
 if(!prod && state.last_nombre){ prod={sku:state.last_sku,nombre_completo:state.last_nombre,precio:state.last_precio}; }

 let respuesta='';
 const falta=!state.nombre_cliente?'nombre':!state.telefono_cliente?'telefono':!state.departamento?'departamento':!state.municipio?'municipio':null;

 if(esQuiero && prod && falta){
   if(falta==='nombre') respuesta=`¡Excelente! 🎉 *${prod.nombre_completo}* $${prod.precio}\n\nPara apartarlo necesito:\n1️⃣ Tu nombre completo ✨`;
   if(falta==='telefono') respuesta=`Gracias ${state.nombre_cliente}! Ahora tu número 📱`;
   if(falta==='departamento') respuesta=`¿De qué departamento sos?`;
   if(falta==='municipio') respuesta=`¿Y municipio?`;
   await supa.from('whatsapp_state').upsert({telefono:remoteJid,paso:`collecting_${falta}`},{onConflict:'telefono'});
 } else if(state.paso?.startsWith('collecting_')){
   const campo=state.paso.replace('collecting_','');
   const val=campo==='telefono'?rawText.replace(/\D/g,'').slice(-8):rawText;
   const col=campo==='nombre'?'nombre_cliente':campo==='telefono'?'telefono_cliente':campo;
   await supa.from('whatsapp_state').upsert({telefono:remoteJid,[col]:val},{onConflict:'telefono'});
   const st2=(await supa.from('whatsapp_state').select('*').eq('telefono',remoteJid).single()).data;
   const sig=!st2.nombre_cliente?'nombre':!st2.telefono_cliente?'telefono':!st2.departamento?'departamento':!st2.municipio?'municipio':null;
   if(sig){ respuesta=sig==='nombre'?'Tu nombre completo porfa':sig==='telefono'?'Tu número 📱':sig==='departamento'?'¿Departamento?':'¿Municipio?'; await supa.from('whatsapp_state').upsert({telefono:remoteJid,paso:`collecting_${sig}`},{onConflict:'telefono'}); }
   else { respuesta=`¡Listo! Decime "lo quiero" para confirmar *${st2.last_nombre}*`; await supa.from('whatsapp_state').upsert({telefono:remoteJid,paso:'idle'},{onConflict:'telefono'}); }
 } else if(esQuiero && prod && !falta){
   await supa.from('whatsapp_orders').insert({telefono:remoteJid,nombre:state.nombre_cliente,telefono_cliente:state.telefono_cliente,departamento:state.departamento,municipio:state.municipio,items:[prod],total:prod.precio,estado:'nuevo'});
   respuesta=`✅ *RESUMEN DE TU PEDIDO*\n\n🛍️ *${prod.nombre_completo}*\n💰 *$${prod.precio}*\n👤 ${state.nombre_cliente}\n📱 ${state.telefono_cliente}\n📍 ${state.departamento}, ${state.municipio}\n\n🚚 Entrega 3-5 días`;
   await supa.from('whatsapp_state').upsert({telefono:remoteJid,paso:'confirmado'},{onConflict:'telefono'});
 } else {
   if(prod) respuesta=`🛍️ *${prod.nombre_completo}*\n💰 Precio: *$${prod.precio}*\n📦 Disponible ✅\n\n¿Te lo aparto? Escribime "lo quiero" 🚚`;
   else respuesta=`¡Hola! 😊 ¿Qué producto buscas? Ej: "porta bebes", "urinario rana"`;
 }

 await supa.from('whatsapp_conversations').insert({telefono:remoteJid,entrada:rawText,respuesta});
 await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,{method:'POST',headers:{'apikey':process.env.EVOLUTION_API_KEY!,'Content-Type':'application/json'},body:JSON.stringify({number:remoteJid,text:respuesta})});
 return Response.json({ok:true});
}
