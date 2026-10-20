export async function POST(req){ const body=await req.json(); await fetch(process.env.N8N_WEBHOOK_URL!,{method:'POST',body:JSON.stringify(body)}); return new Response('ok') }
