export async function POST(req: Request) {
  const body = await req.json();
  const n8nUrl = process.env.N8N_WEBHOOK_URL || 'http://67.205.174.134:5678/webhook/evolution-whatsapp';
  await fetch(n8nUrl, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  return new Response(JSON.stringify({ok:true}), {status:200});
}
export async function GET(){ return new Response('TodoEnUno webhook OK') }
