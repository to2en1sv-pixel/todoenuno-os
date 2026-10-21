import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 10

const EVO_URL = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '')
const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE || 'eee'
const EVO_KEY = process.env.EVOLUTION_API_KEY || ''

function evoHeaders(){ return { 'Content-Type':'application/json', apikey:EVO_KEY, 'User-Agent':'axios/1.13.2' } }
const cleanNumber = (jid:string)=> (jid||'').replace(/:\d+(?=@)/,'').split('@')[0].replace(/\D/g,'')

async function sendText(num:string,text:string){
  console.log('TEST SEND to',num, text)
  try{
    const r=await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`,{method:'POST',headers:evoHeaders(),body:JSON.stringify({number:num,text})})
    const body=await r.text().catch(()=> '')
    console.log('TEST sendText status',r.status,body.slice(0,500))
    return r.ok
  }catch(e){ console.error('TEST send err',e); return false }
}

export async function POST(req: NextRequest){
  try{
    const body=await req.json().catch(()=> ({}))
    console.log('TEST BODY',JSON.stringify(body).slice(0,1500))
    const data=body?.data||{}
    const key=data?.key||{}
    if(key.fromMe) return NextResponse.json({ok:true,skip:'fromMe'})
    const jid=key.remoteJid||''
    if(!jid || jid.includes('@g.us')) return NextResponse.json({ok:true,skip:'jid'})
    const m=data?.message||{}
    const raw=(m.conversation||m.extendedTextMessage?.text||m.imageMessage?.caption||m.buttonsResponseMessage?.selectedButtonId||m.buttonsResponseMessage?.selectedDisplayText||m.listResponseMessage?.singleSelectReply?.selectedRowId||'').trim()
    console.log('TEST RAW',raw,'JID',jid)
    if(!raw) return NextResponse.json({ok:true,skip:'empty'})

    const number=cleanNumber(jid)
    console.log('TEST NUMBER',number)

    await sendText(number, `✅ TEST OK - Recibí: "${raw}" - Evolution eee funcionando - ${new Date().toISOString()}`)

    return NextResponse.json({ok:true,test:'sent'})
  }catch(e:any){
    console.error('TEST fatal',e)
    return NextResponse.json({ok:true,error:String(e?.message||e)})
  }
}

export async function GET(){
  return NextResponse.json({ ok:true, service:'v45-minimal-test-evolution-only', instance:EVO_INSTANCE, evo_url: EVO_URL ? 'set' : 'missing' })
}
