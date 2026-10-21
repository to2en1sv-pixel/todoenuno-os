import { createClient } from '@supabase/supabase-js';

export async function GET() {
  return Response.json({ status: 'webhook alive', instance: 'eee', supabase: 'trgywmhxmkbjfcdvxpnz' });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    console.log('EVOLUTION WEBHOOK:', JSON.stringify(body).slice(0,1000));

    const data = body.data || body;
    const key = data.key || {};
    if (key.fromMe) return Response.json({ ok: true, skip: 'fromMe' });

    const remoteJid = key.remoteJid || data.remoteJid || '';
    const pushName = data.pushName || 'cliente';
    const text = data.message?.conversation || data.message?.extendedTextMessage?.text || data.message?.imageMessage?.caption || '';

    if (!text || !remoteJid) return Response.json({ ok: true });

    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

    // 1. Buscar producto real en tu cache Odoo->Supabase con estado DISPONIBLE/TEST
    const { data: variantes } = await supabase
      .from('productos_variantes')
      .select('sku, nombre_completo, precio')
      .ilike('nombre_completo', `%${text.split(' ').slice(0,3).join('%')}%`)
      .limit(5);

    let stockInfo = 'sin resultados';
    let productoEncontrado: any = null;
    if (variantes && variantes.length) {
      const skus = variantes.map(v => v.sku);
      const { data: cache } = await supabase.from('inventory_cache').select('sku, qty, state').in('sku', skus);
      productoEncontrado = variantes[0];
      stockInfo = JSON.stringify(variantes.map(v => {
        const c = cache?.find(x => x.sku === v.sku);
        return { ...v, qty: c?.qty ?? 0, state: c?.state ?? 'NO_DISPONIBLE' };
      }));
    }

    // 2. GPT con stock real
    let respuesta = `Hola ${pushName}, tenemos: ${stockInfo}`;
    if (process.env.OPENAI_API_KEY) {
      const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: `Eres vendedor TodoEnUno. Inventario real: ${stockInfo}. Estados: DISPONIBLE=hay stock, TEST=publicado sin stock (di "bajo pedido"), NO_DISPONIBLE=no ofrecer. Si preguntan precio da precio y stock. Si quieren comprar di "perfecto te lo aparto".` },
            { role: 'user', content: text }
          ]
        })
      });
      const gptData: any = await gptRes.json();
      respuesta = gptData.choices?.[0]?.message?.content || respuesta;
    }

    // 3. Guardar conversacion
    await supabase.from('whatsapp_conversations').insert({ telefono: remoteJid, entrada: text, respuesta });

    // 4. Si detecta intención de compra, guarda pedido
    const quiereComprar = /quiero|comprar|pedido|ordena|me lo llevo/i.test(text);
    if (quiereComprar && productoEncontrado) {
      await supabase.from('whatsapp_orders').insert({
        telefono: remoteJid,
        nombre: pushName,
        total: productoEncontrado.precio,
        items: [productoEncontrado],
        estado: 'nuevo'
      });
      respuesta += `\n\n✅ Pedido guardado. Te escribimos para confirmar.`;
    }

    // 5. Responder por Evolution
    await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`, {
      method: 'POST',
      headers: { 'apikey': process.env.EVOLUTION_API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: remoteJid, text: respuesta })
    });

    return Response.json({ ok: true });
  } catch (e: any) {
    console.error(e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
