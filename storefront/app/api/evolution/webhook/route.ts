import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 10

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL!
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'eee'
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY!

const norm = (s: string) => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9\s]/g,' ').trim()
const getKey = (jid: string) => (jid||'').replace(/\D/g,'').slice(-11)

async function getState(tel: string){
  const {data}=await supabase.from('whatsapp_state').select('*').eq('telefono',tel).maybeSingle()
  return data||{telefono:tel,nombre_cliente:null,direccion:null,metodo_pago:null,paso:'inicio',last_nombre:null,last_sku:null}
}
async function saveState(tel: string, patch: any){
  const cur=await getState(tel)
  const next={...cur,...patch,telefono:tel,updated_at:new Date().toISOString()}
  await supabase.from('whatsapp_state').upsert(next,{onConflict:'telefono'})
  return next
}
async function getDisponibles(){
  const {data:prods}=await supabase.from('productos_variantes').select('sku,nombre_completo,precio,talla,color')
  if(!prods?.length) return []
  const skus=prods.map(p=>p.sku)
  const {data:inv}=await supabase.from('inventory_cache').select('sku,qty,state').in('sku',skus)
  const map=new Map((inv||[]).map((i:any)=>[i.sku,i]))
  return prods.map((p:any)=>{
    const i:any=map.get(p.sku)
    const state=i?.state||'NO_DISPONIBLE'
    const qty=i?.qty??0
    let ok=false, label='❌ No disponible'
    if(state==='DISPONIBLE'&&qty>0){ok=true;label='✅ Entrega inmediata'}
    else if(state==='TEST'){ok=true;label='✨ Bajo pedido 3-5 días'}
    return {...p,qty,state,disponible:ok,estadoLabel:label,precioNum:Number(p.precio)||0}
  }).filter((p:any)=>p.disponible)
}
function fmt(p:any){
  const l=[`🛍️ *${p.nombre_completo}*`,`💰 Precio: *$${p.precioNum.toFixed(2)}*`]
  if(p.talla) l.push(`📏 Talla: ${p.talla}`)
  if(p.color) l.push(`🎨 Color: ${p.color}`)
  l.push(`📦 ${p.estadoLabel}`)
  return l.join('\n')
}
async function sendText(num: string, text: string){
  try{
    const r=await fetch(`${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`,{method:'POST',headers:{'Content-Type':'application/json',apikey:EVOLUTION_API_KEY},body:JSON.stringify({number:num,text})})
    return r.ok
  }catch{return false}
}
async function sendButtons(num: string, text: string, btns: string[]){
  try{
    const r=await fetch(`${EVOLUTION_API_URL}/message/sendButtons/${EVOLUTION_INSTANCE}`,{method:'POST',headers:{'Content-Type':'application/json',apikey:EVOLUTION_API_KEY},body:JSON.stringify({number:num,text,footer:'TodoEnUno SV | Envío Gratis 🚚',buttons:btns.slice(0,3).map(b=>({displayText:b}))})})
    if(r.ok) return true
  }catch{}
  return sendText(num,text+'\n\n'+btns.map(b=>`• ${b}`).join('\n'))
}
async function sendWA(num: string, text: string, btns?: string[]){
  if(btns?.length) return sendButtons(num,text,btns)
  return sendText(num,text)
}

export async function POST(req: NextRequest){
  try{
    const body=await req.json()
    const data=body?.data||body
    const key=data?.key||body?.key
    const remoteJid=key?.remoteJid||data?.remoteJid||''
    if(!remoteJid||remoteJid.includes('@g.us')||key?.fromMe) return NextResponse.json({ok:true})

    const number=remoteJid.replace('@s.whatsapp.net','').replace(/\D/g,'')
    const telefono=getKey(remoteJid)
    const mc=data?.message||body?.message||{}
    const raw=(mc.conversation||mc.extendedTextMessage?.text||mc.imageMessage?.caption||mc.buttonsResponseMessage?.selectedButtonId||mc.buttonsResponseMessage?.selectedDisplayText||mc.listResponseMessage?.singleSelectReply?.selectedRowId||'').trim()
    if(!raw) return NextResponse.json({ok:true})

    await supabase.from('whatsapp_buffer').insert({telefono,mensaje:raw})
    await new Promise(r=>setTimeout(r,3500))
    const {data:buf}=await supabase.from('whatsapp_buffer').select('mensaje').eq('telefono',telefono).order('created_at',{ascending:true})
    if(!buf?.length) return NextResponse.json({ok:true})
    const mensajes=buf.map((b:any)=>b.mensaje).join(' | ')
    await supabase.from('whatsapp_buffer').delete().eq('telefono',telefono)

    const st=await getState(telefono)
    const disponibles=await getDisponibles()
    if(!disponibles.length) {
      await sendWA(number,'🛍️ Estamos actualizando stock, escribí en 1 min ✨')
      return NextResponse.json({ok:true})
    }

    // buscar producto
    const nMsg=norm(mensajes)
    let prod:any=disponibles.find((p:any)=>p.sku===st.last_sku)
    if(!prod){
      for(const w of nMsg.split(' ').filter((x:string)=>x.length>3)){
        const f=disponibles.find((p:any)=>norm(p.nombre_completo).includes(w))
        if(f){prod=f;break}
      }
    }
    if(!prod) prod=disponibles[0]

    // mini agente
    let respuesta='', buttons: string[]=[], newState:any={}

    if(['hola','buenas','hey','ola'].some(v=>nMsg===v||nMsg.startsWith(v+' '))){
      respuesta=`🛍️ *¡Hola! Bienvenido a TodoEnUno* 👋\n\nTenemos *${disponibles.length} productos* disponibles, por ejemplo:\n• *${disponibles[0].nombre_completo}* a *$${disponibles[0].precioNum.toFixed(2)}*\n\n¿En qué te ayudo hoy? 😊`
      buttons=['🛍️ Ver catálogo','💬 Asesor']
      newState={last_sku:prod.sku,last_nombre:prod.nombre_completo}
    } else if(nMsg.includes('catalogo')||nMsg.includes('que tienen')||nMsg.includes('que venden')){
      const lista=disponibles.slice(0,7).map((p:any)=>`• *${p.nombre_completo}* - $${p.precioNum.toFixed(2)}`).join('\n')
      respuesta=`🛍️ *Tenemos ${disponibles.length} productos* 🥳\n\n${lista}\n\nDecime cuál te gusta 😊`
      buttons=['Ver más','Asesor']
    } else if(nMsg.includes('solo eso')||nMsg.includes('nada mas')){
      const lista=disponibles.slice(0,5).map((p:any)=>`• *${p.nombre_completo}* - $${p.precioNum.toFixed(2)}`).join('\n')
      respuesta=`¡Claro que no! Tenemos mucho más 🔥\n\n${lista}\n\n¿Cuál te gusta?`
      buttons=['Ver catálogo','Asesor']
    } else if(nMsg.includes('quiero')||nMsg.includes('pedir')||nMsg.includes('comprar')||nMsg.includes('mandeme')||st.paso==='pedir_datos'||st.nombre_cliente){
      let nombre=st.nombre_cliente, dir=st.direccion, pago=st.metodo_pago
      const low=nMsg
      if(!nombre && mensajes.trim().split(' ').length>=2 && mensajes.trim().split(' ').length<=4 && !low.includes('colonia') && !low.includes('efectivo') && mensajes.length<50) nombre=mensajes.split('|')[0].trim()
      if(low.includes('colonia')||low.includes('calle')||low.includes('san salvador')||low.includes('escalon')) dir=mensajes
      if(low.includes('efectivo')) pago='efectivo'
      if(low.includes('transferencia')) pago='transferencia'

      if(nombre&&dir&&pago){
        await supabase.from('whatsapp_orders').insert({telefono,nombre,telefono_cliente:telefono,direccion:dir,items:[{nombre:prod.nombre_completo,sku:prod.sku}],total:prod.precioNum,estado:'confirmado',metodo_pago:pago})
        respuesta=`✅ *PEDIDO CONFIRMADO* 🎉\n\n🛍️ ${prod.nombre_completo}\n💰 Total: *$${prod.precioNum.toFixed(2)}*\n👤 ${nombre}\n📍 ${dir}\n💳 ${pago}\n\n🚚 *Envío GRATIS* 24-72h ✨`
        newState={paso:'confirmado',nombre_cliente:nombre,direccion:dir,metodo_pago:pago,last_sku:null,last_nombre:null}
      } else {
        let preg='¡Súper! Me falta:\n'
        if(!nombre) preg+='\n📝 *Nombre completo:*'
        if(!dir) preg+='\n📍 *Dirección:* colonia, municipio, depto'
        if(!pago) preg+='\n💳 *Pago:* efectivo o transferencia'
        preg+='\n\nMandame eso y lo dejamos listo ✨'
        respuesta=preg
        buttons=['✅ Confirmar','✏️ Cambiar datos']
        newState={paso:'pedir_datos',nombre_cliente:nombre,direccion:dir,metodo_pago:pago,last_sku:prod.sku,last_nombre:prod.nombre_completo}
      }
    } else {
      // info producto
      respuesta=`${fmt(prod)}\n\n¿Te lo aparto? Decime "lo quiero" 🚚`
      buttons=['✅ Lo quiero','🛍️ Ver más','❓ Duda']
      newState={last_sku:prod.sku,last_nombre:prod.nombre_completo}
    }

    if(Object.keys(newState).length) await saveState(telefono,newState)
    await sendWA(number,respuesta,buttons)
    await supabase.from('whatsapp_conversations').insert({telefono,entrada:mensajes,respuesta})

    return NextResponse.json({ok:true})
  }catch(e:any){
    console.error(e)
    return NextResponse.json({ok:false,error:String(e?.message||e)},{status:200})
  }
}

export async function GET(){
  return NextResponse.json({status:'ok v41-fixed',instance:EVOLUTION_INSTANCE})
}
