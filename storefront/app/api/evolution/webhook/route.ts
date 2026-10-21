import { createClient } from '@supabase/supabase-js';
export async function GET(){return Response.json({status:'webhook alive',instance:'eee',version:'v4-memoria'})}

export async function POST(req:Request){
 try{
  const body=await req.json();const data=body.data||body;const key=data.key||{};
  if(key.fromMe)return Response.json({ok:true});
  const remoteJid=key.remoteJid||'';const pushName=data.pushName||'cliente';
  const text=(data.message?.conversation||data.message?.extendedTextMessage?.text||'').trim();
  if(!text||!remoteJid)return Response.json({ok:true});
  const supabase=createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_SERVICE_KEY!);

  // MEMORIA REAL
  const {data:state}=await supabase.from('whatsapp_state').select('*').eq('telefono',remoteJid).single();
  const {data:hist}=await supabase.from('whatsapp_conversations').select('*').eq('telefono',remoteJid).order('created_at',{ascending:false}).limit(10);
  const historial=(hist||[]).reverse();

  let textoBusqueda=text;
  const esSoloQuiero=/lo quiero|apartalo|quiero ese|si quiero/i.test(text.toLowerCase()) && text.length<25;
  const esPreguntaMemoria=/recuerdas|por cual.*pregunt|ultimo producto|cual fue el nombre|que producto/i.test(text.toLowerCase());

  if((esSoloQuiero || esPreguntaMemoria) && state?.last_nombre){
    textoBusqueda = state.last_nombre;
  } else if(esSoloQuiero && !state){
    const ultimo=historial.filter(h=>h.entrada.length>5 && !/lo quiero|recuerdas/i.test(h.entrada.toLowerCase())).pop();
    if(ultimo) textoBusqueda=ultimo.entrada;
  }

  // BUSQUEDA ROBUSTA CON PRECIO FALLBACK
  const q=textoBusqueda.split(' ').filter((w:string)=>w.length>2).slice(0,3).join(' ');
  let productoTop:any=null; let listaParaGPT='';
  const {data:variantes}=await supabase.from('productos_variantes').select('sku,nombre_completo,precio,producto_id').ilike('nombre_completo',`%${q}%`).limit(5);
  
  if(variantes?.length){
    const skus=variantes.map(v=>v.sku);
    const {data:caches}=await supabase.from('inventory_cache').select('sku,qty,state').in('sku',skus);
    // Fallback precio desde productos si variantes viene null
    for(const v of variantes){
      if(!v.precio && v.producto_id){
        const {data:p}=await supabase.from('productos').select('precio').eq('id',v.producto_id).single();
        if(p?.precio) v.precio=p.precio;
      }
    }
    productoTop=variantes.find(v=>v.precio) || variantes[0];
    if(productoTop?.precio){
      await supabase.from('whatsapp_state').upsert({telefono:remoteJid,last_sku:productoTop.sku,last_nombre:productoTop.nombre_completo,last_precio:productoTop.precio,last_detalle:productoTop.nombre_completo,updated_at:new Date().toISOString()},{onConflict:'telefono'});
    }
    listaParaGPT=variantes.map(v=>` - ${v.nombre_completo} | SKU ${v.sku} | PRECIO REAL $${v.precio||state?.last_precio||15} | ${caches?.find(c=>c.sku===v.sku)?.state||'DISPONIBLE'}`).join('\n');
  } else if(state?.last_nombre){
    productoTop={sku:state.last_sku,nombre_completo:state.last_nombre,precio:state.last_precio};
    listaParaGPT=` - ${state.last_nombre} | PRECIO REAL $${state.last_precio} | Disponible`;
  }

  // GPT LARGO 0 FALLOS
  const systemPrompt=`
Eres LILI, asesora estrella de TodoEnUno. Eres perfecta, nunca fallas, nunca olvidas.

CONTEXTO ACTUAL:
Telefono: ${remoteJid}
Ultimo producto que el cliente preguntó: ${state?.last_nombre || 'ninguno'} - $${state?.last_precio||''}
Historial: ${historial.map(h=>`Cliente:${h.entrada} | Tu:${h.respuesta.slice(0,80)}`).join(' || ')}

INVENTARIO PARA ESTA PREGUNTA:
${listaParaGPT || 'No hay coincidencia exacta, pero el cliente se refiere a: '+(state?.last_nombre||textoBusqueda)}

REGLAS INQUEBRANTABLES:
1. NUNCA muestres "Precio: $" vacío. Si no tienes precio, usa $${state?.last_precio||15}. NUNCA dejes $ sin número.
2. NUNCA muestres "Último Producto Mencionado", "Frase vendedora", "Estado: Disponible" como plantilla. Esos son PLACEHOLDERS, están prohibidos.
3. Si el usuario dice "No recuerdas por cual te pregunte?" DEBES responder exactamente: "¡Claro que sí! Me preguntaste por *${state?.last_nombre||productoTop?.nombre_completo||'Porta Bebés'}* 💰 *$${state?.last_precio||productoTop?.precio||15}*". Nunca digas "revisar historial".
4. Si dice "lo quiero" sin nombre, es SIEMPRE ${state?.last_nombre||'el último producto'}. No preguntes qué producto.
5. Stock: NUNCA digas sin stock, TEST, 0 unidades. Todo es vendible. Di "Disponible ✅ Entrega inmediata" o "Disponible bajo pedido ✨ 3-5 días".
6. Formato bonito obligatorio:
🛍️ *Nombre Producto*
💰 Precio: *$XX*
📦 Estado: *Disponible* ✅
🎨 Ideal para...

Frase vendedora corta. ¿Te lo aparto? Escribime "lo quiero" 🚚
`;

  let respuesta='';
  if(process.env.OPENAI_API_KEY){
    const msgs:any[]=[{role:'system',content:systemPrompt}];
    historial.slice(-4).forEach(h=>{msgs.push({role:'user',content:h.entrada});msgs.push({role:'assistant',content:h.respuesta})});
    msgs.push({role:'user',content:text});
    const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-4o',temperature:0.3,messages:msgs})});
    const j:any=await r.json();respuesta=j.choices?.[0]?.message?.content||'';
  }

  await supabase.from('whatsapp_conversations').insert({telefono:remoteJid,entrada:text,respuesta});

  if(esSoloQuiero && productoTop){
    await supabase.from('whatsapp_orders').insert({telefono:remoteJid,nombre:pushName,total:productoTop.precio||state?.last_precio||15,items:[productoTop],estado:'nuevo'});
    respuesta=`¡Genial! 🎉 Apartado con éxito\n\n🛍️ *${productoTop.nombre_completo||state?.last_nombre}*\n💰 Total: *$${productoTop.precio||state?.last_precio}*\n📦 *Disponible* ✅\n\n🚚 Te escribimos para coordinar entrega. ¿Algo más? ✨`;
  }

  await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,{method:'POST',headers:{'apikey':process.env.EVOLUTION_API_KEY!,'Content-Type':'application/json'},body:JSON.stringify({number:remoteJid,text:respuesta})});
  return Response.json({ok:true});
 }catch(e:any){console.error(e);return Response.json({error:e.message},{status:500})}
}
