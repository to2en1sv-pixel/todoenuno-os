import { createClient } from '@supabase/supabase-js';
export async function GET(){return Response.json({fix:'porta vs portable + base vacia'})}
const norm=(s:string)=>(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const tokenize=(s:string)=>norm(s).split(/[^a-z0-9]+/).filter(Boolean);

export async function POST(req:Request){
  const b=await req.json(); const d=b.data||b; if(d.key?.fromMe) return Response.json({ok:true});
  const jid=d.key?.remoteJid||''; const raw=(d.message?.conversation||d.message?.extendedTextMessage?.text||'').trim();
  if(!raw||!jid) return Response.json({ok:true});
  const supa=createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

  const {data:vars, error:e1}=await supa.from('productos_variantes').select('sku,nombre_completo,precio,producto_id').limit(2000);
  console.log('V11 vars', vars?.length, 'error', e1, 'query', raw);
  if(e1) console.error('SUPABASE ERROR', e1);

  const qTokens=tokenize(raw).filter(w=>!['quiero','informacion','del','para','que','hola'].includes(w));
  let prod:any=null;

  if(vars?.length){
    // busca porta bebes con palabra exacta, no substring dentro de portable
    const scored=vars.map(v=>{
      const nameTokens=tokenize(v.nombre_completo);
      let score=0;
      for(const q of qTokens){
        if(nameTokens.includes(q)) score+=20;
        if(nameTokens.includes(q.slice(0,-1))) score+=10; // bebes -> bebe
        if(q==='porta' && nameTokens.includes('porta')) score+=30;
        if(q==='bebe' && nameTokens.some(t=>t.startsWith('bebe'))) score+=30;
      }
      // penaliza si es bocina y buscamos porta bebes
      if(qTokens.includes('bebe') && nameTokens.includes('bocina')) score-=50;
      return {...v, score};
    }).filter(v=>v.score>0).sort((a,b)=>b.score-a.score);
    prod=scored[0]||null;
    console.log('top', scored.slice(0,3).map(s=>`${s.nombre_completo} ${s.score}`));
  }

  const {data:st}=await supa.from('whatsapp_state').select('*').eq('telefono',jid).single();
  if(prod) await supa.from('whatsapp_state').upsert({telefono:jid,last_sku:prod.sku,last_nombre:prod.nombre_completo,last_precio:prod.precio},{onConflict:'telefono'});

  const esQuiero=/lo quiero/i.test(raw.toLowerCase());
  const falta=!st?.nombre_cliente?'nombre':!st?.telefono_cliente?'telefono':!st?.departamento?'departamento':!st?.municipio?'municipio':null;
  let resp='';
  if(!vars?.length) resp=`⚠️ xpnz devolvió 0 filas. Error: ${e1?.message||'RLS o key mal'}. Revisa Vercel env SUPABASE_SERVICE_KEY`;
  else if(esQuiero && (prod||st?.last_nombre)){
    const p=prod||{nombre_completo:st.last_nombre, precio:st.last_precio};
    if(falta){
      resp=falta==='nombre'?`¡Perfecto! *${p.nombre_completo}* $${p.precio} - Dime tu nombre completo`:falta==='telefono'?`Tu teléfono 📱`:falta==='departamento'?`¿Departamento?`:`¿Municipio?`;
      await supa.from('whatsapp_state').upsert({telefono:jid,paso:`collecting_${falta}`},{onConflict:'telefono'});
    }else{
      await supa.from('whatsapp_orders').insert({telefono:jid,nombre:st.nombre_cliente,telefono_cliente:st.telefono_cliente,departamento:st.departamento,municipio:st.municipio,items:[p],total:p.precio,estado:'nuevo'});
      resp=`✅ RESUMEN\n🛍️ ${p.nombre_completo}\n💰 $${p.precio}\n👤 ${st.nombre_cliente}\n📱 ${st.telefono_cliente}\n📍 ${st.departamento}, ${st.municipio}`;
    }
  }else{
    if(prod) resp=`🛍️ *${prod.nombre_completo}*\n💰 *$${prod.precio}*\n📦 Disponible ✅\n\n¿Te lo aparto? Escribe "lo quiero" 🚚`;
    else resp=`¡Hola! 😊 Tengo ${vars.length} productos. Escribí "porta bebes" o "urinario rana" - Ej: ${vars.slice(0,2).map(v=>v.nombre_completo).join(', ')}`;
  }

  await supa.from('whatsapp_conversations').insert({telefono:jid,entrada:raw,respuesta:resp});
  await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,{method:'POST',headers:{'apikey':process.env.EVOLUTION_API_KEY!,'Content-Type':'application/json'},body:JSON.stringify({number:jid,text:resp})});
  return Response.json({ok:true});
}
