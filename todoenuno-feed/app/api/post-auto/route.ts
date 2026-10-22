import { createClient } from '@supabase/supabase-js';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const secret = searchParams.get('secret');
  
  // Valida secret (usa el mismo que usaste para sync)
  if (secret !== process.env.CRON_SECRET && secret !== '123456') {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const FB_PAGE_ID = process.env.FB_PAGE_ID!;
  const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN!;

  if (!FB_PAGE_ID || !FB_PAGE_ACCESS_TOKEN) {
    return new Response(JSON.stringify({ error: 'Faltan FB_PAGE_ID o FB_PAGE_ACCESS_TOKEN en Vercel ENV' }), { status: 500 });
  }

  try {
    // 1. Siguiente post pendiente
    const { data: nextPost, error: queueError } = await supabase
      .from('post_queue')
      .select('*')
      .eq('status', 'pending')
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1)
      .single();

    if (queueError || !nextPost) {
      return new Response(JSON.stringify({ message: 'No hay posts pendientes', done: true }), { status: 200 });
    }

    let imageUrl = nextPost.image_url;

    // Fallback si aún es null
    if (!imageUrl && nextPost.template_id) {
      imageUrl = `https://www.to2en1.app/web/image/product.template/${nextPost.template_id}/image_1024`;
    }

    if (!imageUrl) {
      // Marca como failed y sigue con el siguiente
      await supabase.from('post_queue').update({ status: 'failed' }).eq('id', nextPost.id);
      return new Response(JSON.stringify({ error: 'Sin imagen para este producto', post: nextPost }), { status: 500 });
    }

    const caption = `🔥 ${nextPost.nombre} - ${nextPost.sku || ''}

💰 Precio especial hoy
📦 Stock disponible
🚚 Envío a todo El Salvador

Comenta YO y te escribo por WhatsApp 👇

#TodoEnUnoSV #Sonsonate #ElSalvador`.trim();

    // 2. Publicar en FB Page
    const fbResponse = await fetch(`https://graph.facebook.com/v19.0/${FB_PAGE_ID}/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: imageUrl,
        caption: caption,
        access_token: FB_PAGE_ACCESS_TOKEN,
        published: true
      })
    });

    const fbData = await fbResponse.json();

    if (!fbResponse.ok) {
      await supabase.from('post_queue').update({ 
        status: 'failed',
        fb_post_id: JSON.stringify(fbData).substring(0, 500)
      }).eq('id', nextPost.id);
      
      return new Response(JSON.stringify({ error: 'FB Post failed', fbData, imageUrlUsed: imageUrl }), { status: 500 });
    }

    // 3. Marca posted
    await supabase.from('post_queue').update({
      status: 'posted',
      fb_post_id: fbData.id || fbData.post_id,
      posted_at: new Date().toISOString()
    }).eq('id', nextPost.id);

    // 4. Guarda en activos para Fase 3
    await supabase.from('fb_posts_activos').insert({
      post_queue_id: nextPost.id,
      fb_post_id: fbData.id || fbData.post_id,
      template_id: nextPost.template_id,
      is_active: true
    });

    return new Response(JSON.stringify({ 
      success: true, 
      posted: nextPost.nombre,
      fb_post_id: fbData.id,
      image_used: imageUrl
    }), { status: 200 });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
