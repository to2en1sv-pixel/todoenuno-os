export interface OdooProduct {
  id: number; // template_id
  name: string;
  list_price: number;
  website_published: boolean;
  active: boolean;
  image_1920: string | false; // base64 de Odoo
  qty_available?: number;
  default_code?: string;
}

export async function getProducts(): Promise<OdooProduct[]> {
  const ODOO_URL = process.env.ODOO_URL || 'https://www.to2en1.app';
  const ODOO_DB = process.env.ODOO_DB || 'to2en1';
  const ODOO_USER = process.env.ODOO_USER!;
  const ODOO_PASSWORD = process.env.ODOO_PASSWORD!;

  if (!ODOO_USER || !ODOO_PASSWORD) {
    throw new Error('Faltan ODOO_USER / ODOO_PASSWORD en .env');
  }

  // 1. Login para obtener uid
  const loginRes = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: {
        service: 'common',
        method: 'authenticate',
        args: [ODOO_DB, ODOO_USER, ODOO_PASSWORD, {}]
      },
      id: 1
    })
  });
  const loginData = await loginRes.json();
  const uid = loginData.result;
  if (!uid) throw new Error('No se pudo autenticar en Odoo: ' + JSON.stringify(loginData));

  // 2. Buscar productos publicados con imagen
  const fetchProducts = async () => {
    const res = await fetch(`${ODOO_URL}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          service: 'object',
          method: 'execute_kw',
          args: [
            ODOO_DB,
            uid,
            ODOO_PASSWORD,
            'product.template',
            'search_read',
            [[['website_published', '=', true]]], // solo publicados
            {
              fields: ['id', 'name', 'list_price', 'website_published', 'active', 'image_1920', 'default_code'],
              limit: 200
            }
          ]
        },
        id: 2
      })
    });
    const data = await res.json();
    return data.result as OdooProduct[];
  };

  const products = await fetchProducts();
  console.log(`Odoo: Traídos ${products.length} productos con imagen`);
  return products;
}

// Helper para obtener URL directa de Odoo sin necesidad de base64 (fallback rápido)
export function getOdooImageUrl(templateId: number, size: 'image_1920' | 'image_1024' = 'image_1024') {
  const base = process.env.ODOO_URL || 'https://www.to2en1.app';
  return `${base}/web/image/product.template/${templateId}/${size}`;
}
