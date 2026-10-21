import { createClient } from '@supabase/supabase-js';
export async function GET(){return Response.json({status:'webhook alive',instance:'eee',supabase:'trgywmhxmkbjfcdvxpnz'})}
function friendlyStock(c:any){if(!c||c.qty===0)return{text:'Disponible ✨',sub:'Disponible bajo pedido (3-5 días)'};if(c.state==='DISPONIBLE')return{text:'Disponible ✅',sub:`${c.qty} unidades - Entrega inmediata`};return{text:'Disponible ✨',sub:'Disponible bajo pedido (3-5 días)'}}

export async function POST(req:Request){
 try{
  const body=await req.json();const data=body.data||body;const key=data.key||{};if(key.fromMe)return Response.json({ok:true});
  const remoteJid=key.remoteJid||'';const pushName=data.pushName||'cliente';
  const text=data.message?.conversation||data.message?.extendedTextMessage?.text||'';
  if(!text||!remoteJid)return Response.json({ok:true});
  const supabase=createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_SERVICE_KEY!);

  // 1. MEMORIA - trae últimas 6 conversaciones
  const {data:hist}=await supabase.from('whatsapp_conversations').select('*').eq('telefono',remoteJid).order('created_at',{ascending:false}).limit(6);
  const historial=(hist||[]).reverse();

  // 2. Si dice solo "lo quiero", usa el último producto que preguntó
  let textoBusqueda=text;
  const esSoloQuiero=/^\s*(lo quiero|quiero ese|ese|apartalo|apartamelo|si apartamelo)\s*$/i.test(text)||(text.trim().length<12 && /quiero|aparta/i.test(text));
  if(esSoloQuiero){
    const ultimo=historial.filter(h=>h.entrada.length>4 && !/lo quiero|quiero|aparta/i.test(h.entrada.toLowerCase())).pop();
    if(ultimo) textoBusqueda=ultimo.entrada;
  }

  // 3. Buscar producto con textoBusqueda
  const q=textoBusqueda.split(' ').filter((w:string)=>w.length>2).slice(0,3).join(' ');
  const {data:variantes}=await supabase.from('productos_variantes').select('sku,nombre_completo,precio').ilike('nombre_completo',`%${q}%`).limit(5);
  let stockForGPT='';let productoTop:any=null;
  if(variantes?.length){
    const skus=variantes.map(v=>v.sku);const {data:caches}=await supabase.from('inventory_cache').select('sku,qty,state').in('sku',skus);
    productoTop=variantes[0];
    stockForGPT=variantes.map(v=>{const c=caches?.find(x=>x.sku===v.sku);const f=friendlyStock(c);return`- ${v.nombre_completo} | $${v.precio} | ${f.text} - ${f.sub}`}).join('\n');
  }

  // 4. GPT con historial
  let respuesta=''; 
  const mensajes:any[]=[{role:'system',content:`
Eres LILI 💁‍♀️ asesora TodoEnUno. 
INVENTARIO:
${stockForGPT}

REGLAS STOCK: NUNCA digas sin stock, no hay, TEST, DISPONIBLE. Todo lo que ves se puede vender. Si es 0 di "Disponible ✨ bajo pedido 3-5 días". Cliente no debe saber lógica interna.

REGLA MEMORIA: Si usuario dice "lo quiero", "apartalo" sin nombre, ES EL ÚLTIMO PRODUCTO que tú mencionaste en historial. No preguntes de nuevo qué producto.

FORMATO: 🛍️ *Nombre* \n💰 Precio: *$* \n📦 Estado: *Disponible* ✅ \n🎨 Detalle\nFrase vendedora. Termina con "¿Te lo aparto? Escribime lo quiero 🚚"
`}];
  historial.forEach(h=>{mensajes.push({role:'user',content:h.entrada});mensajes.push({role:'assistant',content:h.respuesta})});
  mensajes.push({role:'user',content:text});

  if(process.env.OPENAI_API_KEY){
    const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-4o-mini',temperature:0.7,messages:mensajes})});
    const j:any=await r.json();respuesta=j.choices?.[0]?.message?.content||'';
  }

  await supabase.from('whatsapp_conversations').insert({telefono:remoteJid,entrada:text,respuesta});

  if(esSoloQuiero && productoTop){
    await supabase.from('whatsapp_orders').insert({telefono:remoteJid,nombre:pushName,total:productoTop.precio,items:[productoTop],estado:'nuevo'});
    respuesta=`¡Genial! 🎉\n\n🛍️ *${productoTop.nombre_completo}* apartado para ti ✅\n\n💰 Total: *$${productoTop.precio}*\n🚚 Te escribimos para coordinar entrega.\n\n¿Algo más que te gustaría? ✨`;
  }

  await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,{method:'POST',headers:{'apikey':process.env.EVOLUTION_API_KEY!,'Content-Type':'application/json'},body:JSON.stringify({number:remoteJid,text:respuesta})});
  return Response.json({ok:true});
 }catch(e:any){console.error(e);return Response.json({error:e.message},{status:500})}
}
