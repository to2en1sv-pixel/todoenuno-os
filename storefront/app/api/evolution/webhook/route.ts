import { createClient } from '@supabase/supabase-js';
export async function GET(){return Response.json({os:'todoenuno-os', storefront:'todoenuno-os-storefront', v:'v8-os-ultimate'})}

const norm = (s:string)=>(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
function kws(t:string){
  const stop=new Set(['quiero','mas','informacion','info','sobre','del','para','como','hola','que','tienes','tienen','producto','productos','dame','me','puedes','dar','un','una','el','la']);
  return norm(t).replace(/[^a-z0-9 ]/g,' ').split(' ').filter(w=>w.length>=3).filter(w=>!stop.has(w));
}

export async function POST(req:Request){
  const body=await req.json(); const d=body.data||body;
  if(d.key?.fromMe) return Response.json({ok:true});
  const remoteJid=d.key?.remoteJid||''; const raw=(d.message?.conversation||d.message?.extendedTextMessage?.text||'').trim();
  if(!raw||!remoteJid) return Response.json({ok:true});
  
  const supa=createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
  
  const {data:st}=await supa.from('whatsapp_state').select('*').eq('telefono',remoteJid).single();
  let state=st||{telefono:remoteJid,paso:'idle'};
  const {data:hist}=await supa.from('whatsapp_conversations').select('*').eq('telefono',remoteJid).order('created_at',{ascending:false}).limit(10);
  const historial=(hist||[]).reverse();

  // BUSQUEDA DESDE TODOENUNO-OS -> productos_variantes en xpnz
  const {data:allVars}=await supa.from('productos_variantes').select('sku,nombre_completo,precio,producto_id').limit(3000);
  const search=kws(raw);
  let candidatos:any[]=[];
  if(allVars?.length && search.length){
    candidatos=allVars.filter(v=>{
      const n=norm(v.nombre_completo);
      return search.every(s=>n.includes(s)) || search.some(s=>n.includes(s.slice(0,4)));
    }).sort((a,b)=> norm(b.nombre_completo).length - norm(a.nombre_completo).length);
  }
  if(!candidatos.length && /productos|tienes|catalogo|vendes/i.test(raw)) candidatos=allVars?.slice(0,5)||[];

  let prod=candidatos[0]||null;
  if(prod && !prod.precio){
    const {data:p}=await supa.from('productos').select('precio').eq('id',prod.producto_id).single();
    if(p?.precio) prod.precio=p.precio;
  }
  const esQuiero=/lo quiero|apartalo/i.test(raw.toLowerCase());
  if((esQuiero||/recuerdas|por cual/i.test(raw.toLowerCase())) && !prod && state.last_nombre){
    prod={sku:state.last_sku,nombre_completo:state.last_nombre,precio:state.last_precio};
  }
  if(prod) await supa.from('whatsapp_state').upsert({telefono:remoteJid,last_sku:prod.sku,last_nombre:prod.nombre_completo,last_precio:prod.precio},{onConflict:'telefono'});

  const falta=!state.nombre_cliente?'nombre':!state.telefono_cliente?'telefono':!state.departamento?'departamento':!state.municipio?'municipio':null;
  let resp='';

  if(esQuiero && prod){
    if(falta){
      if(falta==='nombre') resp=`¡Excelente! 🎉 *${prod.nombre_completo}*\n💰 *$${prod.precio}*\n\nPara apartarlo necesito:\n\n1️⃣ Tu *nombre completo* ✨`;
      if(falta==='telefono') resp=`¡Gracias ${state.nombre_cliente}! ✅\n\n2️⃣ Tu *número de teléfono* 📱`;
      if(falta==='departamento') resp=`3️⃣ ¿De qué *departamento* sos?`;
      if(falta==='municipio') resp=`4️⃣ ¿Y tu *municipio*?`;
      await supa.from('whatsapp_state').upsert({telefono:remoteJid,paso:`collecting_${falta}`},{onConflict:'telefono'});
    } else {
      const {error}=await supa.from('whatsapp_orders').insert({telefono:remoteJid,nombre:state.nombre_cliente,telefono_cliente:state.telefono_cliente,departamento:state.departamento,municipio:state.municipio,items:[prod],total:prod.precio,estado:'nuevo'});
      console.log('OS ORDER INSERT', error||'ok');
      resp=`✅ *RESUMEN DE TU PEDIDO - TODOENUNO OS* ✅\n\n🛍️ *${prod.nombre_completo}*\n💰 *$${prod.precio}*\n👤 ${state.nombre_cliente}\n📱 ${state.telefono_cliente}\n📍 ${state.departamento}, ${state.municipio}\n\n🚚 Entrega 3-5 días`;
      await supa.from('whatsapp_state').upsert({telefono:remoteJid,paso:'confirmado'},{onConflict:'telefono'});
    }
  } else if(state.paso?.startsWith('collecting_')){
    const campo=state.paso.replace('collecting_',''); const val=campo==='telefono'?raw.replace(/\D/g,'').slice(-8):raw.trim();
    const col=campo==='nombre'?'nombre_cliente':campo==='telefono'?'telefono_cliente':campo;
    await supa.from('whatsapp_state').upsert({telefono:remoteJid,[col]:val},{onConflict:'telefono'});
    resp=`¡Anotado! Escribime "lo quiero" para confirmar *${state.last_nombre||'tu producto'}*`;
    await supa.from('whatsapp_state').upsert({telefono:remoteJid,paso:'idle'},{onConflict:'telefono'});
  } else {
    if(prod && process.env.OPENAI_API_KEY){
      const sys=`Eres LILI de TodoEnUno OS. Vendes perfecto. Stock: ${candidatos.slice(0,3).map(v=>`${v.nombre_completo} $${v.precio}`).join(', ')}. Ultimo: ${state.last_nombre} $${state.last_precio}. REGLAS: Nunca digas sin stock, TEST, 0 unidades. Todo es vendible como "Disponible ✨". Precio nunca vacío. Si preguntan que productos tienes, lista 3 de OS. Formato: 🛍️ *Nombre* \\n💰 Precio: *$* \\n📦 Disponible ✅ \\n¿Te lo aparto?`;
      const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-4o',temperature:0.3,messages:[{role:'system',content:sys},{role:'user',content:raw}]})});
      const j:any=await r.json(); resp=j.choices?.[0]?.message?.content||`🛍️ *${prod.nombre_completo}*\n💰 *$${prod.precio}*\n📦 Disponible ✅`;
    } else if(prod){
      resp=`🛍️ *${prod.nombre_completo}*\n💰 Precio: *$${prod.precio}*\n📦 Disponible ✅\n\n¿Te lo aparto? Escribime "lo quiero" 🚚`;
    } else {
      resp=allVars?.length?`¡Hola! 😊 En OS tenemos ${allVars.length} productos. Ej: ${allVars.slice(0,3).map(v=>v.nombre_completo).join(', ')}\nDecime cual te interesa`:`¡Hola! ¿Qué producto buscas?`;
    }
  }

  await supa.from('whatsapp_conversations').insert({telefono:remoteJid,entrada:raw,respuesta:resp});
  await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,{method:'POST',headers:{'apikey':process.env.EVOLUTION_API_KEY!,'Content-Type':'application/json'},body:JSON.stringify({number:remoteJid,text:resp})});
  return Response.json({ok:true});
}
