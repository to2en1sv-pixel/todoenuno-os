import { createClient } from '@supabase/supabase-js';

export async function GET() {
  return Response.json({ status: 'webhook alive', instance: 'eee', supabase: 'trgywmhxmkbjfcdvxpnz' });
}

function friendlyStock(cache: any) {
  // TODO activo en Odoo = siempre vendible, nunca decimos sin stock
  if (!cache) return { text: 'Disponible ✨', sub: 'Entrega 3-5 días' };
  if (cache.state === 'DISPONIBLE' && cache.qty > 0) return { text: `Disponible ✅`, sub: `${cache.qty} unidades - Entrega inmediata` };
  // TEST y NO_DISPONIBLE = lo vendemos como "bajo pedido" natural, sin decir que no hay
  return { text: 'Disponible ✨', sub: 'Disponible bajo pedido (3-5 días)' };
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const data = body.data || body;
    const key = data.key || {};
    if (key.fromMe) return Response.json({ ok: true });

    const remoteJid = key.remoteJid || '';
    const pushName = data.pushName || 'cliente';
    const text = data.message?.conversation || data.message?.extendedTextMessage?.text || data.message?.imageMessage?.caption || '';
    if (!text || !remoteJid) return Response.json({ ok: true });

    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

    // 1. Buscar productos
    const q = text.split(' ').filter((w:string)=>w.length>2).slice(0,2).join(' ');
    const { data: variantes } = await supabase.from('productos_variantes').select('sku,nombre_completo,precio').ilike('nombre_completo', `%${q}%`).limit(5);
    
    let stockForGPT = 'No hay coincidencias exactas, ofrece lo más similar.';
    let productoTop: any = null;
    if (variantes?.length) {
      const skus = variantes.map(v=>v.sku);
      const { data: caches } = await supabase.from('inventory_cache').select('sku,qty,state').in('sku', skus);
      productoTop = variantes[0];
      stockForGPT = variantes.map(v=>{
        const c = caches?.find(x=>x.sku===v.sku);
        const f = friendlyStock(c);
        return `- ${v.nombre_completo} | SKU ${v.sku} | $${v.precio} | ${f.text} - ${f.sub}`;
      }).join('\n');
    }

    // 2. GPT bonito
    let respuesta = 'Hola!';
    if (process.env.OPENAI_API_KEY) {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.7,
          messages: [
            { role: 'system', content: `
Eres LILI 💁‍♀️ asesora de TodoEnUno El Salvador. Vendes con cariño y cerrás ventas.

INVENTARIO REAL (no muestres SKU al cliente a menos que pregunte):
${stockForGPT}

REGLAS DE ORO - STOCK:
- NUNCA digas: "no tengo stock", "sin stock", "no hay", "está en TEST", "TEST", "DISPONIBLE", "NO_DISPONIBLE", "0 unidades", "no hay entradas".
- Todo producto que aparece aquí está ACTIVO en Odoo y SE PUEDE VENDER.
- Si dice "Disponible ✨" o "Disponible bajo pedido" vendelo como si estuviera normal. Di: "¡Sí lo tenemos! ✨" o "¡Sí! Lo tenemos disponible bajo pedido (3-5 días) 🚚"
- El cliente NO debe saber de tu lógica interna de stock/contabilidad. Tú consigues el stock después.
- Si es entrega inmediata dilo: "Entrega inmediata ✅"
- Si es bajo pedido dilo: "Disponible bajo pedido ✨ (3-5 días)"

FORMATO WHATSAPP BONITO (obligatorio):
Usa *negritas*, emojis 🛍️ 💰 📦 🎨 ✅ 🚚 ✨ y saltos de línea.

Estructura:
🛍️ *Nombre Producto*

💰 Precio: *$XX*
📦 Estado: *Disponible* ✅
🎨 Detalle: color/talla si aplica

Frase corta vendedora.

¿Te lo aparto? Escribime "lo quiero" 🚚

Nunca hagas párrafos largos. Siempre termina con pregunta.
` },
            { role: 'user', content: text }
          ]
        })
      });
      const j:any = await r.json();
      respuesta = j.choices?.[0]?.message?.content || respuesta;
    }

    // 3. Guardar conversación
    await supabase.from('whatsapp_conversations').insert({ telefono: remoteJid, entrada: text, respuesta });

    // 4. Guardar pedido si dice lo quiero
    if (/lo quiero|quiero|comprar|ordena|aparta/i.test(text) && productoTop) {
      await supabase.from('whatsapp_orders').insert({ telefono: remoteJid, nombre: pushName, total: productoTop.precio, items: [productoTop], estado: 'nuevo' });
      respuesta += `\n\n✅ *Pedido guardado* - Te confirmo por aquí en breve.`;
    }

    // 5. Enviar por Evolution
    await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`, {
      method: 'POST',
      headers: { 'apikey': process.env.EVOLUTION_API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: remoteJid, text: respuesta })
    });

    return Response.json({ ok: true });
  } catch (e:any) {
    console.error(e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
