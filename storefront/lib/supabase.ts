// storefront/lib/supabase.ts - COMPLETO CON SYNC DE IMÁGENES
import { createClient } from '@supabase/supabase-js';
import { getProducts, getOdooImageUrl } from './odoo';

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// Cliente con service_role para subir imágenes
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // IMPORTANTE: pon esta key en .env
);

export async function syncOdooToSupabase() {
  console.log('Iniciando sync Odoo -> Supabase con imágenes...');
  const odooProducts = await getProducts();

  for (const prod of odooProducts) {
    let finalImageUrl = getOdooImageUrl(prod.id); // Fallback directo de Odoo

    // Si tiene image_1920 base64, súbela a Supabase Storage para tener URL estable y rápida para FB
    if (prod.image_1920) {
      try {
        const buffer = Buffer.from(prod.image_1920, 'base64');
        const fileName = `productos/${prod.id}-${Date.now()}.jpg`;

        // Asegúrate de crear el bucket 'product-images' público en Supabase Storage
        const { error } = await supabaseAdmin.storage
          .from('product-images')
          .upload(fileName, buffer, { contentType: 'image/jpeg', upsert: true });

        if (!error) {
          const { data } = supabaseAdmin.storage.from('product-images').getPublicUrl(fileName);
          finalImageUrl = data.publicUrl;
        }
      } catch (e) {
        console.warn(`No se pudo subir imagen de ${prod.id}, usando URL directa de Odoo`, e);
      }
    }

    // 1. Upsert en tabla productos
    const { error: prodError } = await supabase.from('productos').upsert({
      template_id: prod.id,
      nombre_base: prod.name,
      is_published: prod.website_published,
      active: prod.active,
      image_url: finalImageUrl,
      // agrega list_price si tienes esa columna
    }, { onConflict: 'template_id' });

    if (prodError) console.error('Error upsert productos', prodError);

    // 2. Upsert variante base (si usas productos_variantes)
    const { error: varError } = await supabase.from('productos_variantes').upsert({
      variante_id: prod.id, // si solo tienes una variante por producto, usa template_id como variante_id
      template_id: prod.id,
      sku: prod.default_code || `SKU-${prod.id}`,
      nombre_completo: prod.name,
      image_url: finalImageUrl,
    }, { onConflict: 'variante_id' });

    if (varError) console.error('Error upsert variante', varError);

    // 3. Actualiza inventory_cache con imagen
    await supabase.from('inventory_cache').upsert({
      sku: prod.default_code || `SKU-${prod.id}`,
      qty: (prod as any).qty_available || 0,
      state: 'DISPONIBLE',
      updated_at: new Date().toISOString(),
      image_url: finalImageUrl
    }, { onConflict: 'sku' });
  }

  console.log('Sync completado');
  return { synced: odooProducts.length };
}

// Función para llenar post_queue después del sync (FASE 0)
export async function llenarPostQueue() {
  const { data: productos } = await supabase
    .from('productos')
    .select('template_id, nombre_base, image_url')
    .eq('is_published', true)
    .eq('active', true);

  if (!productos) return;

  for (const p of productos) {
    // Solo crea pending si no existe uno pending ya para ese producto
    const { data: existe } = await supabase
      .from('post_queue')
      .select('id')
      .eq('template_id', p.template_id)
      .eq('status', 'pending')
      .limit(1);

    if (existe && existe.length > 0) continue;

    await supabase.from('post_queue').insert({
      template_id: p.template_id,
      nombre: p.nombre_base,
      image_url: p.image_url,
      content_type: 'venta',
      status: 'pending',
      priority: 0
    });
  }
}
