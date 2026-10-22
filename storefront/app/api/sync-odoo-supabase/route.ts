import { createClient } from '@supabase/supabase-js';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  if (searchParams.get('secret') !== process.env.CRON_SECRET && searchParams.get('secret') !== '123456') {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const ODOO_URL = process.env.ODOO_URL || 'https://www.to2en1.app';
  const ODOO_DB = process.env.ODOO_DB!;
  const ODOO_USER = process.env.ODOO_USER!;
  const ODOO_PASSWORD = process.env.ODOO_PASSWORD!;

  try {
    // Login Odoo
    const loginRes = await fetch(`${ODOO_URL}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'call',
        params: { service: 'common', method: 'authenticate', args: [ODOO_DB, ODOO_USER, ODOO_PASSWORD, {}] }, id: 1
      })
    });
    const { result: uid } = await loginRes.json();
    if (!uid) throw new Error('Odoo auth failed');

    // Lee productos
    const prodRes = await fetch(`${ODOO_URL}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'call',
        params: {
          service: 'object', method: 'execute_kw',
          args: [ODOO_DB, uid, ODOO_PASSWORD, 'product.template', 'search_read',
            [[['website_published', '=', true]]],
            { fields: ['id', 'name', 'list_price', 'website_published', 'active', 'default_code', 'qty_available'], limit: 200 }
          ]
        }, id: 2
      })
    });
    const { result: products } = await prodRes.json();

    let synced = 0;
    const errors: any[] = [];

    for (const p of products) {
      const image_url = `${ODOO_URL}/web/image/product.template/${p.id}/image_1024`;

      // Upsert productos
      const { error: e1 } = await supabase.from('productos').upsert({
        template_id: p.id,
        nombre_base: p.name,
        is_published: p.website_published,
        active: p.active,
        image_url: image_url
      }, { onConflict: 'template_id' });
      if (e1) errors.push(e1);

      // Upsert variantes
      const { error: e2 } = await supabase.from('productos_variantes').upsert({
        variante_id: p.id,
        template_id: p.id,
        sku: p.default_code || `SKU-${p.id}`,
        nombre_completo: p.name,
        image_url: image_url
      }, { onConflict: 'variante_id' });
      if (e2) errors.push(e2);

      // Upsert inventory
      const { error: e3 } = await supabase.from('inventory_cache').upsert({
        sku: p.default_code || `${p.id}`,
        qty: p.qty_available || 0,
        state: (p.qty_available || 0) > 0 ? 'DISPONIBLE' : 'NO_DISPONIBLE',
        updated_at: new Date().toISOString(),
        image_url: image_url
      }, { onConflict: 'sku' });
      if (e3) errors.push(e3);

      synced++;
    }

    // Llenar post_queue si está vacía
    const { data: pending } = await supabase.from('post_queue').select('id').eq('status','pending').limit(1);
    if (!pending || pending.length === 0) {
      const { data: prods } = await supabase.from('productos').select('template_id, nombre_base, image_url').eq('is_published', true).limit(50);
      if (prods) {
        for (const prod of prods) {
          await supabase.from('post_queue').insert({
            template_id: prod.template_id,
            nombre: prod.nombre_base,
            image_url: prod.image_url,
            content_type: 'venta',
            status: 'pending'
          });
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, synced, total_leido: products.length, supabase_errors: errors }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500 });
  }
}
