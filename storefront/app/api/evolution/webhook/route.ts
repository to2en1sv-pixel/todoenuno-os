import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 10

const EVO_URL = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '')
const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE || 'eee'
const EVO_KEY = process.env.EVOLUTION_API_KEY || ''
const OPENAI_KEY = process.env.OPENAI_API_KEY || ''
const FOOTER = 'TodoEnUno SV | Envío Gratis 🚚'

const SB_URL_RAW = process.env.SUPABASE_URL || 'https://trgywmhxmkbjfcdvxpnz.supabase.co'
const SB_URL = SB_URL_RAW.startsWith('http') ? SB_URL_RAW : `https://${SB_URL_RAW}.supabase.co`
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || ''
const supabase = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } })

type Producto = { sku:string; nombre_completo:string; precio:number; talla:string|null; color:string|null; image_url:string|null; qty:number; state:string; precioNum:number }
type Estado = { telefono:string; nombre_cliente:string|null; direccion:string|null; metodo_pago:string|null; paso:string|null; last_nombre:string|null; last_sku:string|null }

const sleep = (ms:number)=> new Promise(r=>setTimeout(r,ms))
const norm = (s:string)=> (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim()
const compact = (s:string)=> norm(s).replace(/\s+/g,'')
const getKey = (jid:string)=> (jid||'').replace(/\D/g,'').slice(-11)
const fmtPrecio = (p:number)=> `$${Number(p||0).toFixed(2).replace(/\.00$/,'')}`
const estadoTxt = (p:Producto)=> p.state==='DISPONIBLE' && p.qty>0 ? '✅ Entrega inmediata' : '✨ Disponible bajo pedido 3-5 días'
function evoHeaders(){ return { 'Content-Type':'application/json', apikey:EVO_KEY, 'User-Agent':'axios/1.13.2' } }

async function sendText(num:string,text:string){
  try{ const r=await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`,{method:'POST',headers:evoHeaders(),body:JSON.stringify({number:num,text})}); if(!r.ok) console.error('sendText',r.status); return r.ok }catch(e){ console.error(e); return false }
}
async function sendButtons(num:string,text:string,btns:string[]){
  try{
    const res=await fetch(`${EVO_URL}/message/sendButtons/${EVO_INSTANCE}`,{method:'POST',headers:evoHeaders(),body:JSON.stringify({number:num,title:'TodoEnUno',description:text,text,footer:FOOTER,buttons:btns.slice(0,3).map(b=>({type:'reply',displayText:b,id:compact(b).slice(0,30)}))})})
    if(res.ok) return true
  }catch(e){ console.error('buttons',e) }
  return sendText(num, text + (btns.length? `\n\n${btns.map(b=>`👉 ${b}`).join('\n')}`:''))
}
async function sendWA(num:string,text:string,btns?:string[]){ if(btns?.length) return sendButtons(num,text,btns); return sendText(num,text) }

async function getState(tel:string): Promise<Estado>{
  const {data}=await supabase.from('whatsapp_state').select('*').eq('telefono',tel).maybeSingle()
  return (data as Estado) || { telefono:tel, nombre_cliente:null, direccion:null, metodo_pago:null, paso:null, last_nombre:null, last_sku:null }
}
async function saveState(st:Estado){ await supabase.from('whatsapp_state').upsert({...st,updated_at:new Date().toISOString()},{onConflict:'telefono'}) }
async function getHistory(tel:string){ const {data}=await supabase.from('whatsapp_conversations').select('entrada,respuesta').eq('telefono',tel).order('created_at',{ascending:false}).limit(6); return (data||[]).reverse() }
async function saveConv(tel:string,entrada:string,respuesta:string){ await supabase.from('whatsapp_conversations').insert({telefono:tel,entrada,respuesta}) }

async function getDisponibles(): Promise<Producto[]>{
  let allVars:any[]=[]; let from=0; const page=1000
  for(;;){ const {data}=await supabase.from('productos_variantes').select('sku,nombre_completo,precio,talla,color,image_url').range(from,from+page-1); if(!data || data.length===0) break; allVars=allVars.concat(data); if(data.length<page) break; from+=page }
  let allInv:any[]=[]; from=0
  for(;;){ const {data}=await supabase.from('inventory_cache').select('sku,qty,state').range(from,from+page-1); if(!data || data.length===0) break; allInv=allInv.concat(data); if(data.length<page) break; from+=page }
  const invMap=new Map<string,{qty:number,state:string}>()
  for(const i of allInv) invMap.set(i.sku,{qty:Number(i.qty)||0, state:String(i.state||'NO_DISPONIBLE').toUpperCase()})
  const out:Producto[]=[]
  for(const v of allVars){
    const state=invMap.get(v.sku)?.state || 'TEST'
    const qty=invMap.get(v.sku)?.qty ?? 0
    if(state==='NO_DISPONIBLE') continue
    if(state!=='DISPONIBLE' && state!=='TEST') continue
    const precioNum=Number(String(v.precio||0).replace(/[,$\s]/g,''))||0
    out.push({...v, qty, state, precioNum, precio:precioNum})
  }
  return out
}

function fichaProducto(p:Producto){
  const l=[`🛍️ *${p.nombre_completo}*`,`💰 Precio: *${fmtPrecio(p.precioNum)}*`]
  if(p.talla) l.push(`📏 Talla: ${p.talla}`)
  if(p.color) l.push(`🎨 Color: ${p.color}`)
  l.push(`📦 Estado: ${estadoTxt(p)}`)
  return l.join('\n')
}

const esSaludo = (m:string)=> /^(hola+|holi+|buenas?|buenos dias|buenas tardes|buenas noches|hey|ola|saludos|que tal)\b/.test(norm(m)) && norm(m).split(' ').length<=4
const esListar = (m:string)=> /(que tienen|que tenes|que vende|catalogo|sobre que|que info|que productos|solo eso|solo de eso|ver mas|mas productos|que mas|que hay|lista|ver catalogo|muestrame opciones)/.test(norm(m))
const esAsesor = (m:string)=> /(asesor|humano|persona real|agente|hablar con alguien|vendedor|atencion al cliente)/.test(norm(m))
const esPedir = (m:string)=> /(lo quiero|lo llevo|mandeme|mandame|me lo manda|quiero uno|quiero comprar|comprar|pedir|pedido|ordenar|lo_quiero|apartar|confirmar pedido)/.test(norm(m))
const esComoPedir = (m:string)=> /(como (hago|pido|compro|se hace).*(pedido|pedir|comprar)|como lo pido)/.test(norm(m))
const esDuda = (m:string)=> /^(duda|\?|tengo una duda|pregunta)$/.test(norm(m)) || norm(m)==='duda'
const esDireccion = (m:string)=> /(colonia|escalon|san salvador|calle|avenida|pasaje|residencial|municipio|depto|departamento|santa tecla|soyapango|km|casa|#|canton|caserio|lotificacion|urbanizacion|bloque|poligono)/.test(norm(m)) || (/\d/.test(m) && m.length>12)

function detectaPago(m:string): string|null{
  const n=norm(m)
  if(/efectivo|contra entrega|cash/.test(n)) return 'efectivo'
  if(/transfer|deposito|banco/.test(n)) return 'transferencia'
  return null
}
// FIX ES5: sin \p{L} - usa letras latinas comunes
function detectaNombre(m:string): string|null{
  const t=m.trim()
  if(esDireccion(t)||detectaPago(t)) return null
  if(/[@\d\/:]/.test(t)) return null
  const words=t.split(/\s+/).filter(Boolean)
  if(words.length<2||words.length>4) return null
  // Solo letras con acentos salvadoreños, sin unicode property
  if(!words.every(w=>/^[A-Za-zÁÉÍÓÚáéíóúÑñÜü'-]+$/.test(w))) return null
  if(esSaludo(t)||esListar(t)||esPedir(t)||esAsesor(t)) return null
  return t.replace(/\b\w/g,c=>c.toUpperCase())
}

function buscarProducto(msg:string, disp:Producto[]): Producto|null{
  const q=norm(msg)
  if(!q) return null
  const stop=new Set(['precio','cuanto','cuesta','vale','tienen','tiene','hay','quiero','busco','info','de','del','la','el','los','las','un','una','que','es','son','para','por','me','mandeme','ver','como','donde','tienes'])
  const palabras=q.split(' ').filter(w=>w.length>2 && !stop.has(w))
  if(!palabras.length) return null
  const frase=palabras.join(' ')
  let hit=disp.find(p=>norm(p.nombre_completo).includes(frase))
  if(hit) return hit
  hit=disp.find(p=>{ const n=norm(p.nombre_completo); return palabras.every(w=>n.includes(w)) })
  if(hit) return hit
  const sing=(w:string)=> w.length>4 && w.endsWith('s') ? w.slice(0,-1) : w
  const ord=[...palabras].sort((a,b)=>b.length-a.length)
  for(const w of ord){ const s=sing(w); const h=disp.find(p=>norm(p.nombre_completo).includes(s)); if(h) return h }
  return null
}

async function openaiFallback(msg:string, hist:any[], contexto:string): Promise<string|null>{
  if(!OPENAI_KEY) return null
  try{
    const messages=[{role:'system',content:`Sos LILI, vendedora salvadoreña TodoEnUno SV. Hablás de vos, amable, corta max 3 líneas, emojis moderados. Nunca digas "no sé". Nunca inventes productos/precios. Envío GRATIS 24-72h. Pago efectivo/transferencia. Contexto real: ${contexto}`}, ...hist.flatMap((h:any)=>[{role:'user',content:h.entrada},{role:'assistant',content:h.respuesta}]), {role:'user',content:msg}]
    const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${OPENAI_KEY}`},body:JSON.stringify({model:'gpt-4o-mini',temperature:0.2,max_tokens:180,messages})})
    if(!r.ok) return null
    const j=await r.json()
    const t=j?.choices?.[0]?.message?.content?.trim()
    if(!t || t.startsWith('{')) return null
    return t
  }catch{ return null }
}

const BTN_SALUDO=['Ver catálogo','Asesor']
const BTN_PROD=['✅ Lo quiero','🛍 Ver más','❓ Duda']
function faltantes(st:Estado){ const f=[]; if(!st.nombre_cliente) f.push('📝 *Nombre completo:*'); if(!st.direccion) f.push('📍 *Dirección:* colonia, municipio, depto'); if(!st.metodo_pago) f.push('💳 *Pago:* efectivo/transferencia'); return f.join('\n') }

async function miniAgente(tel:string, msg:string, st:Estado, disp:Producto[], hist:any[]){
  if(esAsesor(msg)){ st.paso='asesor'; await saveState(st); return { texto:'Te paso con asesor 🙋‍♀️ En un momento te escribe una persona de nuestro equipo. ¡Gracias! 💛', botones:[] as string[] } }

  if(st.paso==='recolectando' && st.last_sku){
    const pago=detectaPago(msg); if(pago) st.metodo_pago=pago
    else if(esDireccion(msg) && !st.direccion) st.direccion=msg.trim()
    else { const nom=!st.nombre_cliente? detectaNombre(msg):null; if(nom) st.nombre_cliente=nom; else if(!st.direccion && msg.trim().length>12 && !esPedir(msg)) st.direccion=msg.trim() }
    if(st.nombre_cliente && st.direccion && st.metodo_pago){
      const prod=disp.find(p=>p.sku===st.last_sku)
      const nombreProd=prod?.nombre_completo || st.last_nombre || 'Producto'
      const total=prod?.precioNum||0
      await supabase.from('whatsapp_orders').insert({ telefono:tel, nombre:st.nombre_cliente, telefono_cliente:tel, direccion:st.direccion, items:[{sku:st.last_sku,nombre:nombreProd,qty:1,precio:total}], total, estado:'nuevo', metodo_pago:st.metodo_pago })
      st.paso='confirmado'; await saveState(st)
      return { texto:`✅ *PEDIDO CONFIRMADO* 🎉\n\n🛍 ${nombreProd}\n💰 Total: *${fmtPrecio(total)}*\n👤 ${st.nombre_cliente}\n📍 ${st.direccion}\n💳 ${st.metodo_pago}\n\n🚚 *Envío GRATIS 24-72h*\n¡Gracias! 💛`, botones:[] as string[] }
    }
    await saveState(st)
    return { texto:`¡Perfecto! Solo me falta 😊\n\n${faltantes(st)}`, botones:[] as string[] }
  }

  if(esSaludo(msg)){ return { texto:`¡Hola! 👋 Soy *Lili* de TodoEnUno SV 💛\nTenemos *${disp.length}* productos disponibles con envío gratis 🚚\n¿Qué te gustaría ver?`, botones:BTN_SALUDO } }
  if(esComoPedir(msg)){ if(st.last_sku){ st.paso='recolectando'; await saveState(st); return { texto:`¡Muy fácil! 😊 Solo necesito:\n\n${faltantes(st)}\n\nY listo, envío GRATIS 24-72h 🚚`, botones:[] } } return { texto:'¡Fácil! 😊 Elegí un producto, tocá *Lo quiero* y te pido nombre, dirección y forma de pago. Envío GRATIS 🚚', botones:BTN_SALUDO } }
  if(esPedir(msg) || norm(msg)==='lo quiero'){
    const prodMsg=buscarProducto(msg,disp)
    if(prodMsg){ st.last_sku=prodMsg.sku; st.last_nombre=prodMsg.nombre_completo }
    if(st.last_sku){ st.paso='recolectando'; await saveState(st); return { texto:`¡Excelente elección! 🎉 *${st.last_nombre}*\n\n${faltantes(st)}`, botones:[] } }
  }
  if(esDuda(msg)){ const ctx=st.last_nombre? `Producto: ${st.last_nombre}` : `Catálogo ${disp.length}`; const r=await openaiFallback('Tengo una duda', hist, ctx); return { texto: r||'¡Claro! Preguntame lo que quieras 😊 Envío GRATIS 24-72h, pagás efectivo o transferencia 💳', botones: st.last_sku? BTN_PROD:BTN_SALUDO } }
  if(esListar(msg)){ const lista=disp.slice(0,7).map(p=>`• *${p.nombre_completo}* - ${fmtPrecio(p.precioNum)}`).join('\n'); return { texto:`¡Mirá lo que tenemos! ✨\n\n${lista}\n\nEscribime el nombre del que te guste 😊`, botones:['Ver más','Asesor'] } }
  const prod=buscarProducto(msg,disp)
  if(prod){ st.last_sku=prod.sku; st.last_nombre=prod.nombre_completo; st.paso='info'; await saveState(st); return { texto:fichaProducto(prod), botones:BTN_PROD } }
  const muestra=disp.slice(0,7).map(p=>`${p.nombre_completo} ${fmtPrecio(p.precioNum)}`).join('; ')
  const r=await openaiFallback(msg, hist, `Ofrece uno de estos REALES: ${muestra}`)
  const lista=disp.slice(0,7).map(p=>`• *${p.nombre_completo}* - ${fmtPrecio(p.precioNum)}`).join('\n')
  return { texto: r? `${r}\n\n🛍️ *Catálogo:*\n${lista}` : `Esa no la tengo a mano, pero mirá lo que sí tenemos 💛\n\n${lista}`, botones:BTN_SALUDO }
}

export async function POST(req: NextRequest){
  try{
    const body=await req.json().catch(()=> ({}))
    const event=String(body?.event||'').toLowerCase()
    if(event && !event.includes('messages.upsert') && !event.includes('messages_upsert')) return NextResponse.json({ok:true})
    const data=body?.data||{}
    const key=data?.key||{}
    if(key.fromMe) return NextResponse.json({ok:true})
    const jid=key.remoteJid||''
    if(!jid || jid.includes('@g.us') || jid.includes('status@broadcast')) return NextResponse.json({ok:true})
    const m=data?.message||{}
    const raw=(m.conversation||m.extendedTextMessage?.text||m.imageMessage?.caption||m.buttonsResponseMessage?.selectedButtonId||m.buttonsResponseMessage?.selectedDisplayText||m.listResponseMessage?.singleSelectReply?.selectedRowId||'').trim()
    if(!raw) return NextResponse.json({ok:true})
    const tel=getKey(jid)
    const number=jid.split('@')[0]

    const {data:ins}=await supabase.from('whatsapp_buffer').insert({telefono:tel,mensaje:raw}).select('created_at').maybeSingle()
    const miTs=ins?.created_at
    await sleep(3500)
    const {data:buf}=await supabase.from('whatsapp_buffer').select('mensaje,created_at').eq('telefono',tel).order('created_at',{ascending:true})
    if(!buf?.length) return NextResponse.json({ok:true})
    const ultimo=buf[buf.length-1].created_at
    if(miTs && ultimo!==miTs) return NextResponse.json({ok:true})

    const unido=buf.map((b:any)=>b.mensaje).join(' | ')
    await supabase.from('whatsapp_buffer').delete().eq('telefono',tel)

    const msgFinal = buf.length>1 ? buf[buf.length-1].mensaje : unido
    const idMap:Record<string,string>={ lo_quiero:'lo quiero', catalogo:'catalogo', asesor:'asesor', duda:'duda' }
    const finalMsg=idMap[compact(msgFinal)] || unido

    const [st,disp,hist]=await Promise.all([getState(tel), getDisponibles(), getHistory(tel)])
    const out=await miniAgente(tel, finalMsg, st, disp, hist)

    await sendWA(number, out.texto, out.botones as any)
    await saveConv(tel, unido, out.texto)

    return NextResponse.json({ok:true})
  }catch(e:any){ console.error('webhook',e); return NextResponse.json({ok:true}) }
}

export async function GET(){ return NextResponse.json({ ok:true, service:'master-final-es5-fixed', instance:EVO_INSTANCE }) }
