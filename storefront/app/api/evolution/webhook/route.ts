import { createClient } from '@supabase/supabase-js';
export async function GET(){return Response.json({db:'xpnz-original-feed', repo:'todoenuno-os', v:'v9-debug-bucle'})}
const norm=(s:string)=>(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
export async function POST(req:Request){
  try{
    const body=await req.json(); const d=body.data||body; if(d.key?.fromMe) return Response.json({ok:true});
    const remoteJid=d.key?.remoteJid||''; const raw=(d.message?.conversation||d.message?.extendedTextMessage?.text||'').trim();
    if(!raw||!remoteJid) return Response.json({ok:true});
    const supa=createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
    
    const {data:allVars, error:e1}=await supa.from('productos_variantes').select('sku,nombre_completo,precio').limit(3000);
    const {data:allProds, error:e2}=await supa.from('productos').select('id,nombre,precio').limit(100).order('id',{ascending:false});
    console.log('DEBUG V9 allVars count', allVars?.length, 'error', e1, 'allProds count', allProds?.length, 'error2', e2, 'text', raw);

    const kws=norm(raw).replace(/[^a-z0-9 ]/g,' ').split(' ').filter(w=>w.length>=3 && !['quiero','informacion','productos','tienes','que','para','rana','porta','bebes'].includes(w) || ['porta','bebe','rana','urinario'].includes(w));
    const searchTerms=norm(raw).includes('porta')?['porta','bebe']:norm(raw).includes('rana')||norm(raw).includes('urinario')?['urinario','rana']:kws;

    let prod:any=null; let lista:any[]=allVars||[];
    if(allVars?.length && searchTerms.length){
      lista=allVars.filter(v=>{ const n=norm(v.nombre_completo); return searchTerms.some(s=>n.includes(s)) || n.includes('porta') && searchTerms.includes('porta') || n.includes('rana') && searchTerms.includes('rana'); });
      prod=lista[0]||null;
    }
    if(!prod && allProds?.length && searchTerms.length){
      const p=allProds.find(v=>norm(v.nombre).includes(searchTerms[0]));
      if(p) prod={sku:p.id, nombre_completo:p.nombre, precio:p.precio};
    }

    const {data:st}=await supa.from('whatsapp_state').select('*').eq('telefono',remoteJid).single();
    let state=st||{telefono:remoteJid};
    if(prod) await supa.from('whatsapp_state').upsert({telefono:remoteJid,last_nombre:prod.nombre_completo,last_precio:prod.precio,last_sku:prod.sku},{onConflict:'telefono'});

    const esQuiero=/lo quiero|apartalo/i.test(raw.toLowerCase());
    const falta=!state.nombre_cliente?'nombre':!state.telefono_cliente?'telefono':!state.departamento?'departamento':!state.municipio?'municipio':null;
    let resp='';
    if(!allVars?.length && !allProds?.length){
      resp=`⚠️ DEBUG: Base xpnz vacía (0 productos_variantes y 0 productos). OS no está sincronizando a esta base. Revisa todoenuno-os logs. Texto recibido: ${raw}`;
    } else if(esQuiero && (prod||state.last_nombre)){
      const p=prod||{nombre_completo:state.last_nombre,precio:state.last_precio};
      if(falta){
        resp=falta==='nombre'?`¡Perfecto! *${p.nombre_completo}* $${p.precio} - Dime tu nombre completo`:falta==='telefono'?`Ahora tu teléfono 📱`:falta==='departamento'?`¿Departamento?`:`¿Municipio?`;
        await supa.from('whatsapp_state').upsert({telefono:remoteJid,paso:`collecting_${falta}`},{onConflict:'telefono'});
      }else{
        await supa.from('whatsapp_orders').insert({telefono:remoteJid,nombre:state.nombre_cliente,telefono_cliente:state.telefono_cliente,departamento:state.departamento,municipio:state.municipio,items:[p],total:p.precio,estado:'nuevo'});
        resp=`✅ RESUMEN\n🛍️ ${p.nombre_completo}\n💰 $${p.precio}\n👤 ${state.nombre_cliente}\n📱 ${state.telefono_cliente}\n📍 ${state.departamento}, ${state.municipio}`;
      }
    } else if(state.paso?.startsWith('collecting_')){
      const campo=state.paso.replace('collecting_',''); const col=campo==='nombre'?'nombre_cliente':campo==='telefono'?'telefono_cliente':campo;
      await supa.from('whatsapp_state').upsert({telefono:remoteJid,[col]:raw},{onConflict:'telefono'});
      resp=`¡Anotado! Escribe "lo quiero"`;
      await supa.from('whatsapp_state').upsert({telefono:remoteJid,paso:'idle'},{onConflict:'telefono'});
    } else {
      if(prod) resp=`🛍️ *${prod.nombre_completo}*\n💰 *$${prod.precio}*\n📦 Disponible ✅\n\n¿Te lo aparto? Escribe "lo quiero" 🚚`;
      else if(allVars?.length) resp=`¡Hola! 😊 Tengo ${allVars.length} productos en xpnz. Ej:\n${allVars.slice(0,3).map(v=>`• ${v.nombre_completo} $${v.precio}`).join('\n')}\n\nEscribí "porta bebes" o "urinario rana"`;
      else resp=`¡Hola! Base vacía - OS no está mandando productos a xpnz`;
    }

    await supa.from('whatsapp_conversations').insert({telefono:remoteJid,entrada:raw,respuesta:resp});
    await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,{method:'POST',headers:{'apikey':process.env.EVOLUTION_API_KEY!,'Content-Type':'application/json'},body:JSON.stringify({number:remoteJid,text:resp})});
    return Response.json({ok:true, debug:{vars:allVars?.length, prod:prod?.nombre_completo}});
  }catch(e:any){ console.error('FATAL V9', e); return Response.json({error:e.message},{status:500}) }
}
