import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 10

// ============ CONFIG (usa envs Vercel) ============
const EVO_URL = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '')
const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE || 'eee'
const EVO_KEY = process.env.EVOLUTION_API_KEY || ''
const OPENAI_KEY = process.env.OPENAI_API_KEY || ''

const SB_URL_RAW = process.env.SUPABASE_URL || 'https://trgywmhxmkbjfcdvxpnz.supabase.co'
const SB_URL = SB_URL_RAW.startsWith('http') ? SB_URL_RAW : `https://${SB_URL_RAW}.supabase.co`
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || ''

const supabase = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } })

type Producto = { sku:string; nombre_completo:string; precio:number; talla:string|null; color:string|null; image_url:string|null; qty:number; state:string; precioNum:number }
type Estado = { telefono:string; nombre_cliente:string|null; direccion:string|null; metodo_pago:string|null; paso:string|null; last_nombre:string|null; last_sku:string|null }

// ============ HELPERS ES5 SAFE (sin \p{L}) ============
const norm = (s:string)=> (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim()
const getKey = (jid:string)=> (jid||'').replace(/\D/g,'').slice(-11)
const cleanNumber = (jid:string)=> (jid||'').replace(/:\d+(?=@)/,'').split('@')[0].replace(/\D/g,'')
const fmtPrecio = (p:number)=> `$${Number(p||0).toFixed(2).replace(/\.00$/,'')}`
const estadoTxt = (p:Producto)=> p.state==='DISPONIBLE' && p.qty>0 ? '✅ Entrega inmediata' : '✨ Disponible bajo pedido 3-5 días'

function evoHeaders(){ return { 'Content-Type':'application/json', apikey:EVO_KEY, 'User-Agent':'axios/1.13.2' } }

async function sendText(num:string,text:string){
  try{
    const r=await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`,{method:'POST',headers:evoHeaders(),body:JSON.stringify({number:num,text})})
    if(!r.ok) console.error('sendText',r.status,await r.text().catch(()=> ''))
    return r.ok
  }catch(e){ console.error('send err',e); return false }
}

// ============ SUPABASE ============
async function getState(tel:string): Promise<Estado>{
  const {data}=await supabase.from('whatsapp_state').select('*').eq('telefono',tel).maybeSingle()
  return (data as Estado) || { telefono:tel, nombre_cliente:null, direccion:null, metodo_pago:null, paso:null, last_nombre:null, last_sku:null }
}
async function saveState(st:Estado){ await supabase.from('whatsapp_state').upsert({...st,updated_at:new Date().toISOString()},{onConflict:'telefono'}) }
async function saveConv(tel:string,entrada:string,respuesta:string){ await supabase.from('whatsapp_conversations').insert({telefono:tel,entrada,respuesta}) }

// ============ INVENTARIO RESTAURADO (GPT paginación + Grok fallback) ============
// Lo que ya nos daba 41 productos en v41/v38
async function getDisponibles(): Promise<Producto[]>{
  let allVars:any[]=[]; let from=0
  for(;;){
    const {data,error}=await supabase.from('productos_variantes').select('sku,nombre_completo,precio,talla,color,image_url').range(from,from+999)
    if(error){ console.error('vars',error.message); break }
    if(!data||data.length===0) break
    allVars=allVars.concat(data)
    if(data.length<1000) break
    from+=1000
  }
  let allInv:any[]=[]; from=0
  for(;;){
    const {data,error}=await supabase.from('inventory_cache').select('sku,qty,state').range(from,from+999)
    if(error){ console.error('inv',error.message); break }
    if(!data||data.length===0) break
    allInv=allInv.concat(data)
    if(data.length<1000) break
    from+=1000
  }

  const invMap=new Map<string,{qty:number,state:string}>()
  for(const i of allInv) invMap.set(i.sku,{qty:Number(i.qty)||0, state:String(i.state||'NO_DISPONIBLE').toUpperCase()})

  const out:Producto[]=[]
  for(const v of allVars){
    const inv=invMap.get(v.sku)
    // Fallback que nos dio los 41: si no hay inventario, lo tratamos como TEST (web activo Odoo = vendible)
    const state=inv?.state || 'TEST'
    const qty=inv?.qty ?? 0
    if(state==='NO_DISPONIBLE') continue
    // GPT mejora: DISPONIBLE siempre vendible, TEST vendible como bajo pedido (qty 0 = 3-5 días)
    if(state!=='DISPONIBLE' && state!=='TEST') continue
    const precioNum=Number(String(v.precio||0).replace(/[,$\s]/g,''))||0
    if(precioNum<=0) continue
    out.push({...v, qty, state, precioNum, precio:precioNum})
  }
  console.log('TODD disponibles',out.length,'de',allVars.length,'inv',allInv.length)
  return out
}

function fichaProducto(p:Producto){
  const l=[`🛍️ *${p.nombre_completo}*`,`💰 Precio: *${fmtPrecio(p.precioNum)}*`]
  if(p.talla) l.push(`📏 Talla: ${p.talla}`)
  if(p.color) l.push(`🎨 Color: ${p.color}`)
  l.push(`📦 Estado: ${estadoTxt(p)}`,'','¿Te lo aparto? 😊','Responde: Lo quiero')
  return l.join('\n')
}

// ============ DETECCIÓN FUSIONADA (GPT + Claude) - SIN \p{L} ============
const esSaludo = (m:string)=> /^(hola+|holi+|buenas?|buenos dias|buenas tardes|buenas noches|hey|ola|saludos|que tal)\b/.test(norm(m)) && norm(m).split(' ').length<=4
// GPT aportó: sobre que tienes info, solo de eso, que hay disponible
const esListar = (m:string)=> /(que tienen|que tenes|que vende|catalogo|sobre que|que info|que productos|solo eso|solo de eso|ver mas|mas productos|que mas|que hay|lista|ver catalogo|muestrame opciones|que hay disponible)/.test(norm(m))
const esAsesor = (m:string)=> /(asesor|humano|persona real|agente|hablar con alguien|vendedor|atencion al cliente)/.test(norm(m))
const esPedir = (m:string)=> /(lo quiero|lo llevo|mandeme|mandame|me lo manda|quiero uno|quiero comprar|comprar|pedir|pedido|ordenar|lo_quiero|apartar|confirmar pedido)/.test(norm(m))
const esComoPedir = (m:string)=> /(como (hago|pido|compro|se hace).*(pedido|pedir|comprar)|como lo pido)/.test(norm(m))
const esDuda = (m:string)=> /^(duda|\?|tengo una duda|pregunta)$/.test(norm(m)) || norm(m)==='duda'
const esDireccion = (m:string)=> /(colonia|escalon|san salvador|calle|avenida|pasaje|residencial|municipio|depto|departamento|santa tecla|soyapango|km|casa|#|canton|caserio|lotificacion|urbanizacion|bloque|poligono)/.test(norm(m)) || (/\d/.test(m) && m.length>12)

function detectaPago(m:string): string|null{
  const n=norm(m)
  if(/efectivo|contra entrega|cash/.test(n)) return 'efectivo'
  if(/transfer|deposito|banco|transferencia/.test(n)) return 'transferencia'
  return null
}
function detectaNombre(m:string): string|null{
  const t=m.trim()
  if(esDireccion(t)||detectaPago(t)) return null
  if(/[@\d\/:]/.test(t)) return null
  const words=t.split(/\s+/).filter(Boolean)
  if(words.length<2||words.length>4) return null
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

// ============ MINI AGENTE TODD (nombre cambiado de Lili) ============
const BTN_TEXTO_SALUDO = ['Ver catálogo','Asesor'] // solo como texto, no botones reales para no romper Web

function faltantes(st:Estado){
  const f=[]; if(!st.nombre_cliente) f.push('📝 *Nombre completo:*'); if(!st.direccion) f.push('📍 *Dirección:* colonia, municipio, depto'); if(!st.metodo_pago) f.push('💳 *Pago:* efectivo/transferencia'); return f.join('\n')
}

async function miniAgenteTodd(tel:string, msg:string, st:Estado, disp:Producto[]){
  const n=norm(msg)

  if(esAsesor(msg)){
    st.paso='asesor'; await saveState(st)
    return `Te paso con asesor 🙋‍♂️ Soy Todd y dejo tu chat marcado para atención humana. ¡Gracias! 💛`
  }

  // Recolectando datos - flujo que ya nos funcionaba
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
      return `✅ *PEDIDO CONFIRMADO* 🎉\n\n🛍 ${nombreProd}\n💰 Total: *${fmtPrecio(total)}*\n👤 ${st.nombre_cliente}\n📍 ${st.direccion}\n💳 ${st.metodo_pago}\n\n🚚 *Envío GRATIS 24-72h*\n¡Gracias por comprar en TodoEnUno SV! Soy Todd 💛`
    }
    await saveState(st)
    return `¡Perfecto! Soy Todd 😊 Solo me falta:\n\n${faltantes(st)}`
  }

  if(esSaludo(msg)){
    return `¡Hola! 👋 Soy *Todd* de TodoEnUno SV 💛\nTenemos *${disp.length}* productos con envío gratis 🚚\n\n¿Qué te gustaría ver?\n👉 Responde: catalogo\n👉 Responde: asesor`
  }

  if(esComoPedir(msg)){
    if(st.last_sku){ st.paso='recolectando'; await saveState(st); return `¡Muy fácil! Soy Todd 😊 Solo necesito:\n\n${faltantes(st)}\n\nY listo, envío GRATIS 24-72h 🚚` }
    return `¡Fácil! Soy Todd 😊 Elegí un producto, escribe *Lo quiero* y te pido nombre, dirección y forma de pago. Envío GRATIS 🚚`
  }

  if(esPedir(msg) || n==='lo quiero'){
    const prodMsg=buscarProducto(msg,disp)
    if(prodMsg){ st.last_sku=prodMsg.sku; st.last_nombre=prodMsg.nombre_completo }
    if(st.last_sku){ st.paso='recolectando'; await saveState(st); return `¡Excelente elección! 🎉 Soy Todd y te aparto *${st.last_nombre}*\n\n${faltantes(st)}` }
  }

  if(esDuda(msg)){
    return `¡Claro! Soy Todd 😊 Preguntame lo que quieras. Envío GRATIS 24-72h, pagás efectivo o transferencia 💳`
  }

  if(esListar(msg)){
    const lista=disp.slice(0,7).map(p=>`• *${p.nombre_completo}* - ${fmtPrecio(p.precioNum)}`).join('\n')
    return `¡Mirá lo que tenemos! ✨\n\n${lista}\n\nEscribime el nombre del que te guste 😊\nSoy Todd`
  }

  const prod=buscarProducto(msg,disp)
  if(prod){
    st.last_sku=prod.sku; st.last_nombre=prod.nombre_completo; st.paso='info'; await saveState(st)
    return fichaProducto(prod)
  }

  // Fallback: si no encuentra, muestra catálogo real (no inventa)
  const lista=disp.slice(0,7).map(p=>`• *${p.nombre_completo}* - ${fmtPrecio(p.precioNum)}`).join('\n')
  return `Esa no la tengo a mano, pero soy Todd y mirá lo que sí tenemos 💛\n\n${lista}\n\nEscribí el nombre, por ejemplo: porta bebe`
}

// ============ WEBHOOK SIN BUFFER (lo que nos funcionó en 08:15) ============
export async function POST(req: NextRequest){
  try{
    const body=await req.json().catch(()=> ({}))
    const data=body?.data||{}
    const key=data?.key||{}
    if(key.fromMe) return NextResponse.json({ok:true})
    const jid=key.remoteJid||''
    if(!jid || jid.includes('@g.us') || jid.includes('status@broadcast')) return NextResponse.json({ok:true})

    const m=data?.message||{}
    const raw=(m.conversation||m.extendedTextMessage?.text||m.imageMessage?.caption||m.buttonsResponseMessage?.selectedButtonId||m.buttonsResponseMessage?.selectedDisplayText||m.listResponseMessage?.singleSelectReply?.selectedRowId||'').trim()
    if(!raw) return NextResponse.json({ok:true})

    const tel=getKey(jid)
    const number=cleanNumber(jid)

    const [st,disp]=await Promise.all([getState(tel), getDisponibles()])
    const texto=await miniAgenteTodd(tel, raw, st, disp)

    await sendText(number, texto)
    await saveConv(tel, raw, texto)

    return NextResponse.json({ok:true})
  }catch(e:any){
    console.error('webhook todd',e)
    return NextResponse.json({ok:true})
  }
}

export async function GET(){
  return NextResponse.json({ ok:true, service:'todoenuno-todd-intermedio', instance:EVO_INSTANCE, name:'Todd' })
}
