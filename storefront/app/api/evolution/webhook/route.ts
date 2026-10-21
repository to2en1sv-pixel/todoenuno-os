import { createClient } from '@supabase/supabase-js';
export async function GET(){return Response.json({status:'ok',v:'v5-cierre'})}

export async function POST(req:Request){
 const body=await req.json();const d=body.data||body;if((d.key||{}).fromMe)return Response.json({ok:true});
 const remoteJid=(d.key||{}).remoteJid||'';const text=(d.message?.conversation||d.message?.extendedTextMessage?.text||'').trim();
 if(!text||!remoteJid)return Response.json({ok:true});
 const supa=createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_SERVICE_KEY!);
 
 const {data:st}=await supa.from('whatsapp_state').select('*').eq('telefono',remoteJid).single();
 let state=st||{telefono:remoteJid, paso:'idle'};
 const {data:hist}=await supa.from('whatsapp_conversations').select('*').eq('telefono',remoteJid).order('created_at',{ascending:false}).limit(8);
 const historial=(hist||[]).reverse();

 // Buscar producto
 let textoBusqueda=text;
 if(/lo quiero|apartalo/i.test(text) && text.length<25 && state.last_nombre) textoBusqueda=state.last_nombre;
 const q=textoBusqueda.split(' ').filter((w:string)=>w.length>2).slice(0,3).join(' ');
 const {data:vars}=await supa.from('productos_variantes').select('sku,nombre_completo,precio,producto_id').ilike('nombre_completo',`%${q}%`).limit(3);
 let prod:any=vars?.[0]||null;
 if(prod && !prod.precio && prod.producto_id){
   const {data:p}=await supa.from('productos').select('precio').eq('id',prod.producto_id).single();
   if(p?.precio) prod.precio=p.precio;
 }
 if(prod) await supa.from('whatsapp_state').upsert({telefono:remoteJid,last_sku:prod.sku,last_nombre:prod.nombre_completo,last_precio:prod.precio,updated_at:new Date().toISOString(),paso:state.paso},{onConflict:'telefono'});

 const esQuiero=/lo quiero|apartalo|quiero ese/i.test(text.toLowerCase());
 const falta = !state.nombre_cliente ? 'nombre' : !state.telefono_cliente ? 'telefono' : !state.departamento ? 'departamento' : !state.municipio ? 'municipio' : null;

 let respuesta='';
 if(esQuiero && prod){
   if(falta){
     if(falta==='nombre') respuesta=`¡Excelente! 🎉 *${prod.nombre_completo}*\n💰 *$${prod.precio}*\n\nPara apartarlo necesito:\n1️⃣ Tu nombre completo\n\nEscribime tu nombre por favor ✨`;
     if(falta==='telefono') respuesta=`¡Perfecto ${state.nombre_cliente}! ✅\n\nAhora tu número de teléfono 📱`;
     if(falta==='departamento') respuesta=`¡Genial! 📱 ${state.telefono_cliente}\n\n¿De qué departamento sos? (Ej: San Salvador, La Libertad...)`;
     if(falta==='municipio') respuesta=`¿Y municipio? (Ej: Soyapango, Santa Tecla...)`;
     await supa.from('whatsapp_state').upsert({telefono:remoteJid,paso:`collecting_${falta}`,updated_at:new Date().toISOString()},{onConflict:'telefono'});
   } else {
     // TODO completo -> RESUMEN Y GUARDAR
     const total=prod.precio||state.last_precio||15;
     await supa.from('whatsapp_orders').insert({telefono:remoteJid,nombre:state.nombre_cliente,telefono_cliente:state.telefono_cliente,departamento:state.departamento,municipio:state.municipio,items:[prod],total,estado:'nuevo'});
     respuesta=`✅ *RESUMEN DE TU PEDIDO* ✅\n\n🛍️ *${prod.nombre_completo}*\n💰 Precio: *$${total}*\n\n👤 Cliente: *${state.nombre_cliente}*\n📱 Tel: *${state.telefono_cliente}*\n📍 Depto: *${state.departamento}*\n🏘️ Municipio: *${state.municipio}*\n\n🚚 Entrega 3-5 días - Te confirmamos por aquí. ¡Gracias! 🎉`;
     await supa.from('whatsapp_state').upsert({telefono:remoteJid,paso:'confirmado'},{onConflict:'telefono'});
   }
 } else if(state.paso?.startsWith('collecting_')){
   const campo=state.paso.replace('collecting_','');
   let val=text; if(campo==='telefono') val=text.replace(/\D/g,'').slice(-8);
   await supa.from('whatsapp_state').upsert({telefono:remoteJid,[campo==='nombre'?'nombre_cliente':campo==='telefono'?'telefono_cliente':campo]:val,updated_at:new Date().toISOString()},{onConflict:'telefono'});
   const st2=(await supa.from('whatsapp_state').select('*').eq('telefono',remoteJid).single()).data;
   state=st2; const sig=!st2.nombre_cliente?'nombre':!st2.telefono_cliente?'telefono':!st2.departamento?'departamento':!st2.municipio?'municipio':null;
   if(sig){
     respuesta=sig==='telefono'?`¡Gracias ${st2.nombre_cliente}! Ahora tu número 📱`:sig==='departamento'?`Perfecto! ¿Departamento?`:sig==='municipio'?`¿Municipio?`:`¿${sig}?`;
     await supa.from('whatsapp_state').upsert({telefono:remoteJid,paso:`collecting_${sig}`},{onConflict:'telefono'});
   } else {
     respuesta=`¡Listo! Ya tengo todo. Decime "lo quiero" de nuevo para confirmar tu *${state.last_nombre}* 🎉`;
     await supa.from('whatsapp_state').upsert({telefono:remoteJid,paso:'idle'},{onConflict:'telefono'});
   }
 } else {
   // Flujo normal de info
   if(prod){
     respuesta=`🛍️ *${prod.nombre_completo}*\n\n💰 Precio: *$${prod.precio||state.last_precio}*\n📦 Estado: *Disponible* ✅\n🎨 Ideal para tu bebé\n\n¿Te lo aparto? Escribime "lo quiero" 🚚`;
   } else {
     respuesta=`¡Hola! 😊 ¿Qué producto buscas? Ej: "porta bebes", "urinario rana"`;
   }
 }

 await supa.from('whatsapp_conversations').insert({telefono:remoteJid,entrada:text,respuesta});
 await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,{method:'POST',headers:{'apikey':process.env.EVOLUTION_API_KEY!,'Content-Type':'application/json'},body:JSON.stringify({number:remoteJid,text:respuesta})});
 return Response.json({ok:true});
}
