import { createClient } from '@supabase/supabase-js';
export const dynamic = 'force-dynamic';
const norm = (s:string)=> (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const getKey = (j:string)=> j.split('@')[0].replace(/[^0-9]/g,'').slice(-11);
const slug = (s:string)=> norm(s).replace(/[^a-z0-9]+/g,'-');

async function getState(s:any,k:string){const {data}=await s.from('whatsapp_state').select('*').eq('telefono',k).limit(1).maybeSingle();return data;}
async function saveState(s:any,k:string,u:any){const e=await getState(s,k);const m={...(e||{}),...u,telefono:k};await s.from('whatsapp_state').delete().eq('telefono',k);await s.from('whatsapp_state').insert(m);}

function buildPrompt(vars:any[],st:any){
 const p=vars.find((v:any)=>norm(v.nombre_completo).includes(norm(st.last_nombre||'porta bebes')))||vars[0];
 const link=`https://to2en1.app/shop/${slug(p.nombre_completo)}`;
 const t=p.talla?`Talla ${p.talla}`:''; const c=p.color?`Color ${p.color}`:'';
 return `Eres Todd de to2en1.app. Producto: ${p.nombre_completo} $${p.precio} ${t} ${c} Link: ${link}
 ESTADO: ${st.nombre_cliente?`Nombre=${st.nombre_cliente}`:'FALTA Nombre'} | ${st.direccion?`Dir=${st.direccion}`:'FALTA Direccion'} | ${st.metodo_pago?`Pago=${st.metodo_pago}`:'FALTA Pago'}
 JSON: {"accion":"respuesta_simple o confirmar_pedido","sku":"${p.nombre_completo}","nombre_cliente":null,"direccion":null,"metodo_pago":null,"respuesta":""}
 Si falta algo pide solo lo que dice FALTA. Si ya tienes Nombre y llega "colonia escalon ss" guardalo como Direccion. Si llega "efectivo" y ya tienes Nombre+Dir confirma.
 Formato pedir: "Para coordinar tu pedido necesito estos datos:||📝 Nombre completo:|📍 Dirección: (colonia, municipio, departamento, calle y punto de referencia)|💳 Método de pago: (efectivo o transferencia)"`;
}

export async function GET(){return Response.json({v:'v30-64lines-real-data'});}
export async function POST(req:Request){
 try{
  const b=await req.json(); const d=b.data||b; if(d.key?.fromMe) return Response.json({ok:true});
  const jid=d.key?.remoteJid||''; const raw=(d.message?.conversation||d.message?.extendedTextMessage?.text||'').trim(); if(!raw||!jid) return Response.json({ok:true});
  const k=getKey(jid); const supa=createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_SERVICE_KEY!);
  // BUFFER 4seg para tus 3 mensajes separados
  await supa.from('whatsapp_buffer').insert({telefono:k,mensaje:raw}); await new Promise(r=>setTimeout(r,4000));
  const {data:buf}=await supa.from('whatsapp_buffer').select('mensaje').eq('telefono',k).order('created_at',{ascending:true});
  const msg=(buf?.map((m:any)=>m.mensaje).join(' | ')||raw).trim(); await supa.from('whatsapp_buffer').delete().eq('telefono',k);
  const {data:vars}=await supa.from('productos_variantes').select('*').limit(500);
  let st=await getState(supa,k); if(!st) st={telefono:k};
  const sys=buildPrompt(vars||[],st); const hist=await supa.from('whatsapp_conversations').select('entrada,respuesta').eq('telefono',k).order('created_at',{ascending:true}).limit(10);
  const messages:any[]=[{role:'system',content:sys}]; if(hist.data) for(const h of hist.data){messages.push({role:'user',content:h.entrada});messages.push({role:'assistant',content:h.respuesta});} messages.push({role:'user',content:msg});
  const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-4o-mini',temperature:0.2,messages})});
  const j=await r.json(); let p:any; try{p=JSON.parse(j.choices?.[0]?.message?.content?.replace(/```json/g,'').replace(/```/g,'').trim()||'{}');}catch{p={};}
  const n=norm(msg);
  if(!p.nombre_cliente && !st.nombre_cliente && n.split(' ').length>=2 && !n.includes('colonia') && !n.includes('efectivo') && n.length<40) p.nombre_cliente=msg.split('|')[0].trim();
  if(n.includes('colonia')||n.includes('escalon')||n.includes('ss')) p.direccion=msg;
  if(n.includes('efectivo')) p.metodo_pago='efectivo'; if(n.includes('transferencia')) p.metodo_pago='transferencia';
  if(!p.nombre_cliente) p.nombre_cliente=st.nombre_cliente; if(!p.direccion) p.direccion=st.direccion; if(!p.metodo_pago) p.metodo_pago=st.metodo_pago; if(!p.sku) p.sku=st.last_nombre||'PORTA BEBES';
  const okN=p.nombre_cliente?.length>2, okD=p.direccion?.length>5, okP=p.metodo_pago?.length>0;
  let resp=""; if(okN&&okD&&okP){p.accion='confirmar_pedido'; const prod=vars?.find((v:any)=>norm(v.nombre_completo).includes(norm(p.sku))); await supa.from('whatsapp_orders').insert({telefono:k,nombre:p.nombre_cliente,telefono_cliente:k,direccion:p.direccion,items:[{nombre:p.sku,talla:prod?.talla,color:prod?.color}],total:prod?.precio||15,estado:'nuevo',metodo_pago:p.metodo_pago}); await saveState(supa,k,{paso:'confirmado',nombre_cliente:p.nombre_cliente,direccion:p.direccion,metodo_pago:p.metodo_pago,last_nombre:p.sku}); resp=`✅ PEDIDO CONFIRMADO\n🛍️ ${p.sku}${prod?.talla?`\n📏 Talla: ${prod.talla}`:''}${prod?.color?`\n🎨 Color: ${prod.color}`:''}\n👤 ${p.nombre_cliente}\n📍 ${p.direccion}\n💳 ${p.metodo_pago}\n🔗 https://to2en1.app/shop/${slug(p.sku)}\n\n🚚 Envio GRATIS 24-72h`;}else{p.accion='respuesta_simple'; await saveState(supa,k,{nombre_cliente:p.nombre_cliente,direccion:p.direccion,metodo_pago:p.metodo_pago,last_nombre:p.sku}); resp="Para coordinar tu pedido necesito estos datos:||📝 Nombre completo:|📍 Dirección: (colonia, municipio, departamento, calle y punto de referencia)|💳 Método de pago: (efectivo o transferencia)";}
  await supa.from('whatsapp_conversations').insert({telefono:k,entrada:msg,respuesta:resp}); await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,{method:'POST',headers:{'apikey':process.env.EVOLUTION_API_KEY!,'Content-Type':'application/json'},body:JSON.stringify({number:jid,text:resp.replace(/\|/g,'\n')})});
  return Response.json({ok:true});
 }catch(e:any){return Response.json({error:e.message},{status:500});}
}
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
