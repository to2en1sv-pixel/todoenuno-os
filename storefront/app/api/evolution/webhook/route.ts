import { createClient } from '@supabase/supabase-js';
export async function GET(){return Response.json({v:'v13-xpnz-11-cols'})}
const norm=(s:string)=>(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const toks=(s:string)=>norm(s).split(/[^a-z0-9]+/).filter(Boolean);

export async function POST(req:Request){
  const b=await req.json(); const d=b.data||b; if(d.key?.fromMe) return Response.json({ok:true});
  const jid=d.key?.remoteJid||''; const raw=(d.message?.conversation||d.message?.extendedTextMessage?.text||'').trim();
  if(!raw||!jid) return Response.json({ok:true});
  const supa=createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

  // SELECT * para no fallar por columnas que no existen en xpnz
  const {data:vars, error}=await supa.from('productos_variantes').select('*').limit(2000);
  console.log('V13 vars', vars?.length, 'err', error?.message, 'cols', vars?.[0]? Object.keys(vars[0]) : 'none');

  if(error){
    const msg=`Error xpnz: ${error.message}`;
    await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,{method:'POST',headers:{'apikey':process.env.EVOLUTION_API_KEY!,'Content-Type':'application/json'},body:JSON.stringify({number:jid,text:msg})});
    return Response.json({ok:false});
  }

  const q=toks(raw).filter(w=>!['quiero','informacion','del','para','hola'].includes(w));
  let prod:any=null;

  if(vars?.length){
    const scored=vars.map(v=>{
      const name=toks(v.nombre_completo||'');
      let s=0;
      for(const qq of q){
        if(name.includes(qq)) s+=20;
        if(qq==='bebes' && name.includes('bebe')) s+=20;
        if(qq==='porta' && name.includes('porta') && !name.includes('portable')) s+=50;
        if(qq==='porta' && name.includes('portable')) s-=30; // penaliza Bocina X-312 Portable
      }
      if(q.length>=2 && q.every(x=> name.includes(x) || (x==='bebes'&&name.includes('bebe')))) s+=60;
      return {...v, s, nameT:name};
    }).filter(v=>v.s>0).sort((a,b)=>b.s-a.s);
    prod=scored[0]||null;
  }

  // Fix directo para tus 2 productos clave
  if(!prod && /porta.*bebe/i.test(norm(raw))) prod=vars?.find(v=>norm(v.nombre_completo).includes('porta') && norm(v.nombre_completo).includes('bebe'))||null;
  if(!prod && /urinario/i.test(norm(raw))) prod=vars?.find(v=>norm(v.nombre_completo).includes('urinario'))||null;

  // precio viene de productos vía template_id si no está en variantes
  let precioFinal = prod?.precio || prod?.list_price || 15;
  if(prod && !prod.precio && prod.template_id){
    const {data:p}=await supa.from('productos').select('precio,precio_venta,list_price').eq('id', prod.template_id).single();
    precioFinal = p?.precio || p?.precio_venta || p?.list_price || 15;
  }

  const {data:st}=await supa.from('whatsapp_state').select('*').eq('telefono',jid).single();
  if(prod) await supa.from('whatsapp_state').upsert({telefono:jid,last_sku:prod.sku,last_nombre:prod.nombre_completo,last_precio:precioFinal},{onConflict:'telefono'});

  const esQuiero=/lo quiero/i.test(raw.toLowerCase());
  const falta=!st?.nombre_cliente?'nombre':!st?.telefono_cliente?'telefono':!st?.departamento?'departamento':!st?.municipio?'municipio':null;
  let resp='';
  if(esQuiero && (prod||st?.last_nombre)){
    const p=prod? {...prod, precio:precioFinal} : {nombre_completo:st.last_nombre, precio:st.last_precio};
    if(falta){
      resp=falta==='nombre'?`¡Perfecto! *${p.nombre_completo}* $${p.precio} - Dime tu nombre completo`:falta==='telefono'?`Tu teléfono 📱`:falta==='departamento'?`¿Departamento?`:`¿Municipio?`;
      await supa.from('whatsapp_state').upsert({telefono:jid,paso:`collecting_${falta}`},{onConflict:'telefono'});
    }else{
      await supa.from('whatsapp_orders').insert({telefono:jid,nombre:st.nombre_cliente,telefono_cliente:st.telefono_cliente,departamento:st.departamento,municipio:st.municipio,items:[p],total:p.precio,estado:'nuevo'});
      resp=`✅ RESUMEN\n🛍️ ${p.nombre_completo}\n💰 $${p.precio}\n👤 ${st.nombre_cliente}\n📍 ${st.departamento}, ${st.municipio}`;
    }
  }else{
    if(prod) resp=`🛍️ *${prod.nombre_completo}*\n💰 Precio: *$${precioFinal}*\n📦 Disponible ✅\n\n¿Te lo aparto? Escribe "lo quiero" 🚚`;
    else resp=`¡Hola! Tengo ${vars?.length} productos. Escribe "porta bebes"`;
  }

  await supa.from('whatsapp_conversations').insert({telefono:jid,entrada:raw,respuesta:resp});
  await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,{method:'POST',headers:{'apikey':process.env.EVOLUTION_API_KEY!,'Content-Type':'application/json'},body:JSON.stringify({number:jid,text:resp})});
  return Response.json({ok:true});
}
