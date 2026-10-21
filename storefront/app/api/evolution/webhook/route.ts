import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

type AnyRecord = Record<string, unknown>;
type AgentAction =
  | 'respuesta_simple'
  | 'confirmar_pedido'
  | 'pedir_datos'
  | 'listar_productos';

type InventoryState = 'DISPONIBLE' | 'TEST' | 'NO_DISPONIBLE' | string;

interface ProductRow {
  sku: string;
  nombre_completo: string;
  precio: number | string | null;
  talla?: string | null;
  color?: string | null;
  image_url?: string | null;
}

interface InventoryRow {
  sku: string;
  qty: number | string | null;
  state: InventoryState;
}

interface Product extends ProductRow {
  sku: string;
  nombre_completo: string;
  precio: number;
  talla: string | null;
  color: string | null;
  image_url: string | null;
  inventoryState: InventoryState;
  qty: number;
}

interface WhatsAppState {
  telefono: string;
  nombre_cliente: string | null;
  direccion: string | null;
  metodo_pago: string | null;
  paso: string | null;
  last_nombre: string | null;
  last_sku: string | null;
}

interface ConversationRow {
  entrada: string;
  respuesta: string;
  created_at?: string;
}

interface BufferedMessage {
  telefono: string;
  mensaje: string;
  created_at: string;
}

interface OrderDraft {
  product: Product;
  state: WhatsAppState;
}

interface AgentResult {
  accion: AgentAction;
  sku: string | null;
  nombre_cliente: string | null;
  direccion: string | null;
  metodo_pago: string | null;
  respuesta: string;
  buttons?: string[];
  state: WhatsAppState;
  order?: OrderDraft;
}

interface IncomingMessage {
  telefono: string;
  numero: string;
  raw: string;
  bufferedText: string;
}

const EVOLUTION_URL = (process.env.EVOLUTION_API_URL || '').trim().replace(/\/+$/, '');
const EVOLUTION_INSTANCE = (process.env.EVOLUTION_INSTANCE || 'eee').trim() || 'eee';
const EVOLUTION_API_KEY = (process.env.EVOLUTION_API_KEY || '').trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = 'gpt-4o-mini';
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
const SUPABASE_URL = normalizeSupabaseUrl((process.env.SUPABASE_URL || '').trim());
const BUFFER_DELAY_MS = 3500;
const PAGE_SIZE = 1000;

function normalizeSupabaseUrl(value: string): string {
  if (!value) return '';
  const clean = value.replace(/\/+$/, '');
  if (/^https?:\/\//i.test(clean)) return clean;
  // Accept both a full Supabase URL and the project reference shown in the prompt.
  if (/^[a-z0-9-]+$/i.test(clean)) return `https://${clean}.supabase.co`;
  return `https://${clean}`;
}

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnyRecord)
    : {};
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function norm(value: unknown): string {
  return asString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compact(value: unknown): string {
  return norm(value).replace(/\s+/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getKey(jidOrNumber: string): string {
  const digits = String(jidOrNumber || '').replace(/\D/g, '');
  return digits.slice(-11);
}

function getSupabaseHeaders(extra: Record<string, string> = {}): HeadersInit {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Missing Supabase configuration');
  }
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'axios/1.13.2',
    ...extra,
  };
}

async function supabaseRequest<T>(
  table: string,
  query: URLSearchParams,
  init: RequestInit = {},
  timeoutMs = 7000,
): Promise<T> {
  const url = `${SUPABASE_URL}/rest/v1/${table}${query.size ? `?${query.toString()}` : ''}`;
  const response = await fetch(url, {
    ...init,
    cache: 'no-store',
    headers: getSupabaseHeaders((init.headers || {}) as Record<string, string>),
    signal: init.signal || AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    const detail = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    throw new Error(`Supabase ${table} ${response.status}: ${detail.slice(0, 500)}`);
  }
  return parsed as T;
}

async function fetchAllRows<T>(table: string, select: string, orderField: string): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const query = new URLSearchParams({ select, order: `${orderField}.asc` });
    const chunk = await supabaseRequest<T[]>(
      table,
      query,
      {
        method: 'GET',
        headers: {
          'Range-Unit': 'items',
          Range: `${offset}-${offset + PAGE_SIZE - 1}`,
        },
      },
      7000,
    );
    const rows = Array.isArray(chunk) ? chunk : [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

async function loadAvailableProducts(): Promise<Product[]> {
  const [productRows, inventoryRows] = await Promise.all([
    fetchAllRows<ProductRow>(
      'productos_variantes',
      'sku,nombre_completo,precio,talla,color,image_url',
      'sku',
    ),
    fetchAllRows<InventoryRow>('inventory_cache', 'sku,qty,state', 'sku'),
  ]);

  const inventoryBySku = new Map<string, InventoryRow>();
  for (const item of inventoryRows) {
    if (item?.sku) inventoryBySku.set(String(item.sku), item);
  }

  const available: Product[] = [];
  for (const row of productRows) {
    if (!row?.sku || !asString(row.nombre_completo)) continue;
    const inv = inventoryBySku.get(String(row.sku));
    if (!inv) continue;

    const state = asString(inv.state).toUpperCase();
    const qtyNumber = Number(inv.qty);
    const qty = Number.isFinite(qtyNumber) ? qtyNumber : 0;
    // productos_variantes is populated from active web products by the Odoo sync.
    // Therefore TEST + qty 0 is explicitly sellable as an order item, not out of stock.
    const immediate = state === 'DISPONIBLE';
    const underOrder = state === 'TEST' && qty === 0;
    if (!immediate && !underOrder) continue;

    const rawPrice = row.precio;
    const price = typeof rawPrice === 'number'
      ? rawPrice
      : Number(String(rawPrice ?? '').replace(/[,$\s]/g, ''));
    if (!Number.isFinite(price) || price < 0) continue;

    available.push({
      ...row,
      sku: String(row.sku),
      nombre_completo: String(row.nombre_completo).trim(),
      precio: price,
      talla: asString(row.talla) || null,
      color: asString(row.color) || null,
      image_url: asString(row.image_url) || null,
      inventoryState: state,
      qty,
    });
  }
  return available;
}

function newState(telefono: string, row?: Partial<WhatsAppState> | null): WhatsAppState {
  return {
    telefono,
    nombre_cliente: asString(row?.nombre_cliente) || null,
    direccion: asString(row?.direccion) || null,
    metodo_pago: asString(row?.metodo_pago) || null,
    paso: asString(row?.paso) || null,
    last_nombre: asString(row?.last_nombre) || null,
    last_sku: asString(row?.last_sku) || null,
  };
}

async function getState(telefono: string): Promise<WhatsAppState> {
  const query = new URLSearchParams({
    select: 'telefono,nombre_cliente,direccion,metodo_pago,paso,last_nombre,last_sku',
    telefono: `eq.${telefono}`,
    limit: '1',
  });
  const rows = await supabaseRequest<Partial<WhatsAppState>[]>('whatsapp_state', query, { method: 'GET' });
  return newState(telefono, Array.isArray(rows) ? rows[0] : null);
}

async function saveState(state: WhatsAppState): Promise<void> {
  const query = new URLSearchParams({ on_conflict: 'telefono' });
  await supabaseRequest<unknown>(
    'whatsapp_state',
    query,
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([state]),
    },
  );
}

async function loadConversationHistory(telefono: string): Promise<ConversationRow[]> {
  const query = new URLSearchParams({
    select: 'entrada,respuesta,created_at',
    telefono: `eq.${telefono}`,
    order: 'created_at.desc',
    limit: '6',
  });
  const rows = await supabaseRequest<ConversationRow[]>('whatsapp_conversations', query, { method: 'GET' });
  return (Array.isArray(rows) ? rows : []).reverse();
}

async function saveConversation(telefono: string, entrada: string, respuesta: string): Promise<void> {
  const query = new URLSearchParams();
  await supabaseRequest<unknown>(
    'whatsapp_conversations',
    query,
    {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{ telefono, entrada, respuesta, created_at: new Date().toISOString() }]),
    },
  );
}

async function insertBuffer(telefono: string, mensaje: string): Promise<void> {
  await supabaseRequest<unknown>(
    'whatsapp_buffer',
    new URLSearchParams(),
    {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{ telefono, mensaje, created_at: new Date().toISOString() }]),
    },
  );
}

async function claimBufferedMessages(telefono: string, cutoff: string): Promise<BufferedMessage[]> {
  // DELETE ... RETURNING atomically claims the rows; concurrent webhook invocations
  // cannot both answer from the same buffer batch.
  const query = new URLSearchParams({
    telefono: `eq.${telefono}`,
    created_at: `lte.${cutoff}`,
    select: 'telefono,mensaje,created_at',
  });
  const rows = await supabaseRequest<BufferedMessage[]>(
    'whatsapp_buffer',
    query,
    {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' },
    },
  );
  return Array.isArray(rows) ? rows : [];
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function availabilityLabel(product: Product): string {
  return product.inventoryState === 'DISPONIBLE'
    ? '✅ Entrega inmediata'
    : '✨ Disponible bajo pedido (3-5 días)';
}

function formatProductInfo(product: Product): string {
  const lines = [
    `🛍️ *${product.nombre_completo}*`,
    `💰 Precio: *$${formatPrice(product.precio)}*`,
  ];
  if (product.talla) lines.push(`📏 Talla: ${product.talla}`);
  if (product.color) lines.push(`🎨 Color: ${product.color}`);
  lines.push(`📦 Estado: ${availabilityLabel(product)}`);
  lines.push('', '¿Te lo aparto? 😊');
  return lines.join('\n');
}

function formatProductList(products: Product[], availableCount: number): string {
  if (products.length === 0) {
    return `🛍️ Estoy actualizando el catálogo, y ahora mismo aparecen *${availableCount} productos disponibles*. 😊\nEscribime *Asesor* para que te ayuden personalmente.`;
  }
  const lines = [`🛍️ *Catálogo disponible*`, `Tenemos *${availableCount} productos disponibles* para vos.`, ''];
  for (const product of products.slice(0, 7)) {
    lines.push(`• *${product.nombre_completo}* - $${formatPrice(product.precio)}`);
  }
  lines.push('', '¿Cuál te llamó la atención? ✨');
  return lines.join('\n');
}

function missingFields(state: WhatsAppState): Array<'nombre' | 'direccion' | 'pago'> {
  const missing: Array<'nombre' | 'direccion' | 'pago'> = [];
  if (!asString(state.nombre_cliente)) missing.push('nombre');
  if (!asString(state.direccion)) missing.push('direccion');
  if (!asString(state.metodo_pago)) missing.push('pago');
  return missing;
}

function promptForMissing(missing: Array<'nombre' | 'direccion' | 'pago'>): string {
  const prompts: Record<'nombre' | 'direccion' | 'pago', string> = {
    nombre: '📝 *Nombre completo:* ¿A nombre de quién lo preparo?',
    direccion: '📍 *Dirección:* Mandame colonia, municipio y departamento.',
    pago: '💳 *Pago:* ¿Vas a pagar en efectivo o transferencia?',
  };
  return ['¡Perfecto! 😊 Para preparar tu pedido solo me falta:', ...missing.map((key) => prompts[key])].join('\n\n');
}

function extractButtonAction(message: AnyRecord): string | null {
  const sources = [
    message.buttonsResponseMessage,
    message.buttonResponseMessage,
    message.listResponseMessage,
  ].map(asRecord);
  const values: string[] = [];
  for (const source of sources) {
    const listReply = asRecord(source.singleSelectReply);
    for (const value of [
      source.selectedButtonId,
      source.selectedDisplayText,
      source.title,
      source.displayText,
      listReply.selectedRowId,
      listReply.title,
    ]) {
      const str = asString(value);
      if (str) values.push(str);
    }
  }
  return mapButtonIntent(values.join(' '));
}

function mapButtonIntent(text: string): string | null {
  const value = norm(text);
  const id = compact(text);
  if (id.includes('loquiero') || value.includes('lo quiero') || value.includes('quiero')) return 'lo_quiero';
  if (id.includes('catalogo') || value.includes('ver catalogo') || value.includes('ver mas') || value.includes('catalogo')) {
    return 'catalogo';
  }
  if (value.includes('asesor') || value.includes('humano') || value.includes('duda') || value.includes('persona')) {
    return 'asesor';
  }
  return null;
}

function extractIncoming(payload: AnyRecord): IncomingMessage | null {
  const data = asRecord(payload.data);
  const key = asRecord(data.key || payload.key);
  const message = asRecord(data.message || payload.message);
  const remoteJid = asString(key.remoteJid || data.remoteJid || payload.remoteJid || payload.sender);
  if (!remoteJid || remoteJid.includes('@g.us') || remoteJid === 'status@broadcast') return null;
  if (String(key.fromMe ?? data.fromMe ?? payload.fromMe ?? '').toLowerCase() === 'true') return null;

  const event = norm(payload.event);
  if (event && !event.includes('messages upsert') && !event.includes('messagesupsert')) return null;

  const normalizedJid = remoteJid.replace(/:\d+(?=@)/, '');
  const digits = normalizedJid.replace(/\D/g, '');
  const telefono = getKey(normalizedJid);
  if (!telefono || digits.length < 8) return null;

  const extended = asRecord(message.extendedTextMessage);
  const image = asRecord(message.imageMessage);
  const button = asRecord(message.buttonsResponseMessage);
  const list = asRecord(message.listResponseMessage);
  const listReply = asRecord(list.singleSelectReply);
  const raw = asString(
    message.conversation ||
      extended.text ||
      image.caption ||
      button.selectedButtonId ||
      button.selectedDisplayText ||
      listReply.selectedRowId,
  );
  if (!raw) return null;

  const buttonAction = extractButtonAction(message);
  const bufferedText = buttonAction ? `__BUTTON__:${buttonAction}` : raw;
  return { telefono, numero: digits, raw, bufferedText };
}

function cleanBufferedText(message: string): string {
  return message
    .replace(/__BUTTON__:lo_quiero/gi, 'lo quiero')
    .replace(/__BUTTON__:catalogo/gi, 'ver catalogo')
    .replace(/__BUTTON__:asesor/gi, 'asesor');
}

function splitMessages(message: string): string[] {
  return cleanBufferedText(message)
    .split(/\s*\|\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function isHumanRequest(text: string): boolean {
  const value = norm(text);
  return /\b(asesor|humano|persona real|agente|hablar con alguien|hablar con una persona|quiero hablar con|atencion al cliente|representante)\b/.test(value);
}

function isListIntent(text: string): boolean {
  const value = norm(text);
  return /\b(catalogo|ver productos|que tienen|que productos|que hay disponible|que hay|sobre que tienes info|sobre que tienen info|solo de eso|solo eso|ver mas|mostrame opciones|muestrame opciones|lista de productos|ensen(a|ame) el catalogo)\b/.test(value);
}

function isGreeting(text: string): boolean {
  const value = norm(text);
  return /^(hola|holi|holaaa|buenos dias|buenas tardes|buenas noches|buenas|hey|que tal|saludos)(\s|$|!|\.)/.test(value) ||
    /^(hola|holi|holaaa|buenos dias|buenas tardes|buenas noches|buenas|hey)$/.test(value);
}

function isOrderIntent(text: string): boolean {
  const value = norm(text);
  return /\b(lo quiero|quiero uno|quiero una|quiero comprar|comprar|mandeme uno|mandame uno|deme uno|deme una|me lo llevo|como lo pido|como hago un pedido|como puedo pedir|hacer un pedido|quiero pedir|confirmar pedido|haz mi pedido|hagamos el pedido|pedirlo|pedirla|lo voy a querer)\b/.test(value) ||
    compact(text) === 'loquiero';
}

function isPaymentQuestion(text: string): boolean {
  return /\b(pago|pagar|efectivo|transferencia|transferir|deposito|banco)\b/.test(norm(text));
}

function isShippingQuestion(text: string): boolean {
  return /\b(envio|entrega|cuando llega|cuanto tarda|tiempo de entrega|gratis|costo de envio)\b/.test(norm(text));
}

function looksLikeAddress(text: string): boolean {
  const value = norm(text);
  return /\b(colonia|escalon|san salvador|calle|avenida|av|pasaje|residencial|municipio|departamento|depto|direccion|boulevard|bulevar|km|canton|caserio|lotificacion|urbanizacion|reparto|bloque|poligono|casa|pasaje|carretera|final de)\b/.test(value) ||
    /\b(casa|lote|poligono|block|numero|nro)\s*\d+\b/.test(value);
}

function isPayment(text: string): string | null {
  const value = norm(text);
  if (/\b(efectivo|cash|contra entrega)\b/.test(value)) return 'Efectivo';
  if (/\b(transferencia|transferir|deposito|depositar|transferencia bancaria)\b/.test(value)) return 'Transferencia';
  return null;
}

function extractLabelledValue(text: string, labels: string[]): string | null {
  const labelPattern = labels.join('|');
  const match = text.match(new RegExp(`^(?:${labelPattern})\\s*[:\\-]?\\s*(.+)$`, 'i'));
  return match?.[1]?.trim() || null;
}

function looksLikeName(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || looksLikeAddress(trimmed) || isPayment(trimmed)) return false;
  if (isOrderIntent(trimmed) || isHumanRequest(trimmed) || isListIntent(trimmed) || isGreeting(trimmed)) return false;
  if (/\b(quiero|busco|necesito|precio|talla|color|info|informacion|catalogo|comprar|pedido|producto|ver|cuanto|cual|tienen|tienes|hay|mostrar|muestra|favor)\b/.test(norm(trimmed))) return false;
  if (/\d|[@/:]/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  if (!words.every((word) => /^[\p{L}'-]+$/u.test(word))) return false;
  const value = norm(trimmed);
  const commonPhrases = [
    'sobre que tienes info', 'sobre que tienen info', 'como hago un pedido', 'como lo pido',
    'solo de eso', 'solo eso', 'buenas tardes', 'buenos dias', 'buenas noches',
  ];
  return !commonPhrases.includes(value);
}

function looksLikeStandaloneName(text: string): boolean {
  const trimmed = text.trim();
  if (!looksLikeName(trimmed)) return false;
  // Outside an active order form, title-cased two-to-four word messages are treated as names.
  // Inside the order form, looksLikeName also accepts lowercase text.
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length >= 2 && words.length <= 4 && words.every((word) => /^\p{Lu}[\p{L}'-]*$/u.test(word));
}

function extractProductQuery(text: string): string {
  let value = norm(text);
  const phrases = [
    'me puedes mostrar', 'me puede mostrar', 'quiero comprar', 'quiero pedir', 'quisiera ver', 'quiero ver', 'informacion sobre',
    'informacion de', 'info sobre', 'info de', 'que sabes de', 'sobre el', 'sobre la',
    'cuanto cuesta', 'cuanto vale', 'cual es el precio de', 'precio de', 'precio', 'cuesta',
    'tienen', 'tienes', 'hay', 'busco', 'necesito', 'quiero', 'me interesa', 'mostrarme',
    'por favor', 'porfa', 'el producto', 'producto', 'comprar', 'pedido de', 'del', 'de la', 'de los', 'de las',
    'el', 'la', 'los', 'las', 'un', 'una', 'por', 'favor', 'vale', 'costo', 'cuanto',
  ];
  phrases.sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    value = value.replace(new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), ' ');
  }
  return value.replace(/\s+/g, ' ').trim();
}

function findProduct(text: string, products: Product[]): Product | null {
  const rawIntent = norm(text);
  const genericOrderCommand = /^(lo quiero|quiero uno|quiero una|mandame uno|mandeme uno|deme uno|deme una|me lo llevo|como lo pido|como hago un pedido|como puedo pedir|hacer un pedido|quiero pedir|confirmar pedido|haz mi pedido|hagamos el pedido|pedirlo|pedirla|lo voy a querer)$/;
  if (isHumanRequest(text) || isListIntent(text) || isGreeting(text) || isShippingQuestion(text) || isPaymentQuestion(text) || genericOrderCommand.test(rawIntent)) return null;
  const query = extractProductQuery(text);
  const qNorm = norm(query);
  const qCompact = compact(query);
  if (!qNorm || qNorm.length < 2) return null;

  for (const product of products) {
    const name = norm(product.nombre_completo);
    const nameCompact = compact(product.nombre_completo);
    if (name.includes(qNorm) || nameCompact.includes(qCompact)) return product;
  }
  for (const product of products) {
    const name = norm(product.nombre_completo);
    const nameCompact = compact(product.nombre_completo);
    if (qNorm.includes(name) && name.length >= 4) return product;
    if (qCompact.includes(nameCompact) && nameCompact.length >= 4) return product;
  }

  const queryTokens = qNorm.split(' ').filter((token) => token.length > 2);
  if (!queryTokens.length) return null;
  const exactTokenMatch = products.find((product) => {
    const nameTokens = new Set(norm(product.nombre_completo).split(' '));
    return queryTokens.every((token) => nameTokens.has(token));
  });
  return exactTokenMatch || null;
}

function looksLikeProductRequest(text: string): boolean {
  const value = norm(text);
  if (!value) return false;
  if (isGreeting(text) || isHumanRequest(text) || isListIntent(text) || isOrderIntent(text)) return false;
  if (looksLikeStandaloneName(text)) return false;
  if (isShippingQuestion(text) || isPaymentQuestion(text)) return false;
  if (/\b(gracias|ok|okay|si|sí|no|dale|perfecto|entiendo|buenisimo|listo)\b/.test(value) && value.split(' ').length <= 3) return false;
  const query = extractProductQuery(text);
  return query.length >= 2;
}

function relatedProducts(query: string, products: Product[], limit = 3): Product[] {
  const tokens = norm(query).split(' ').filter((token) => token.length > 2);
  const ranked = products.map((product) => {
    const name = norm(product.nombre_completo);
    const nameTokens = new Set(name.split(' '));
    const score = tokens.reduce((total, token) => total + (nameTokens.has(token) || name.includes(token) ? 1 : 0), 0);
    return { product, score };
  });
  ranked.sort((a, b) => b.score - a.score || a.product.nombre_completo.localeCompare(b.product.nombre_completo));
  const matches = ranked.filter((item) => item.score > 0).slice(0, limit).map((item) => item.product);
  return matches.length ? matches : products.slice(0, limit);
}

function catalogButtons(): string[] {
  return ['🛍️ Ver catálogo', '👩‍💼 Asesor'];
}

function listButtons(): string[] {
  return ['🛍️ Ver más', '👩‍💼 Asesor'];
}

function productButtons(): string[] {
  return ['✅ Lo quiero', '🛍️ Ver más', '❓ Duda'];
}

function setLastProduct(state: WhatsAppState, product: Product): void {
  state.last_sku = product.sku;
  state.last_nombre = product.nombre_completo;
}

function applyCustomerData(text: string, state: WhatsAppState): void {
  const trimmed = text.trim();
  if (!trimmed || /^__BUTTON__:/i.test(trimmed)) return;
  if (isOrderIntent(trimmed) || isListIntent(trimmed) || isHumanRequest(trimmed) || isGreeting(trimmed)) return;

  const payment = isPayment(trimmed);
  if (payment) state.metodo_pago = payment;

  const labelledName = extractLabelledValue(trimmed, ['mi nombre es', 'nombre completo', 'nombre']);
  if (labelledName && !looksLikeAddress(labelledName)) {
    state.nombre_cliente = labelledName;
  } else if (!state.nombre_cliente && looksLikeName(trimmed)) {
    state.nombre_cliente = trimmed;
  }

  const labelledAddress = extractLabelledValue(trimmed, ['mi direccion es', 'direccion', 'dirección', 'domicilio']);
  if (labelledAddress) {
    state.direccion = labelledAddress;
  } else if (!state.direccion && looksLikeAddress(trimmed)) {
    state.direccion = trimmed;
  } else if (
    !state.direccion &&
    state.nombre_cliente &&
    !payment &&
    !looksLikeName(trimmed) &&
    trimmed.split(/\s+/).length >= 3 &&
    !isProductLikeSmallTalk(trimmed)
  ) {
    state.direccion = trimmed;
  }
}

function isProductLikeSmallTalk(text: string): boolean {
  const value = norm(text);
  return isGreeting(text) || isOrderIntent(text) || isHumanRequest(text) || isListIntent(text) ||
    /\b(gracias|ok|okay|si|no|dale|perfecto|quiero|busco|necesito|precio|talla|color|comprar|pedido|producto|cuanto|catalogo|asesor|duda)\b/.test(value);
}

async function askOpenAI(
  message: string,
  history: ConversationRow[],
  state: WhatsAppState,
  available: Product[],
): Promise<Partial<AgentResult> | null> {
  if (!OPENAI_API_KEY) return null;
  const catalogContext = available.slice(0, 30).map((product) => ({
    sku: product.sku,
    nombre: product.nombre_completo,
    precio: product.precio,
    talla: product.talla,
    color: product.color,
    estado: availabilityLabel(product),
  }));
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    {
      role: 'system',
      content: [
        'Sos Lili, asesora de ventas de TodoEnUno SV en El Salvador. Amable, breve, natural y hablás de vos; usá emojis con moderación.',
        'Respondé únicamente como JSON válido con las claves accion, sku, nombre_cliente, direccion, metodo_pago y respuesta.',
        'accion solo puede ser respuesta_simple, confirmar_pedido, pedir_datos o listar_productos.',
        'No inventés productos, precios, tallas, colores, stock, pedidos ni políticas. Los datos válidos son exclusivamente los del catálogo entregado al final.',
        'La lógica de catálogo y registro de pedidos la ejecuta el sistema. No declares un pedido confirmado; no infieras datos personales.',
        'Para consultas genéricas, respondé en una o dos frases. Nunca respondás que no sabés; ofrecé catálogo o asesor cuando aplique.',
        `Estado de venta actual: ${JSON.stringify({ nombre_cliente: state.nombre_cliente, direccion: state.direccion, metodo_pago: state.metodo_pago, paso: state.paso, last_sku: state.last_sku })}`,
        `Catálogo disponible (muestra real): ${JSON.stringify(catalogContext)}`,
      ].join('\n'),
    },
  ];
  for (const item of history.slice(-6)) {
    if (item.entrada) messages.push({ role: 'user', content: String(item.entrada).slice(0, 1500) });
    if (item.respuesta) messages.push({ role: 'assistant', content: String(item.respuesta).slice(0, 1500) });
  }
  messages.push({ role: 'user', content: message.slice(0, 3000) });

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'axios/1.13.2',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages,
        max_tokens: 250,
      }),
      signal: AbortSignal.timeout(2800),
    });
    if (!response.ok) {
      console.error('OpenAI fallback returned', response.status);
      return null;
    }
    const payload = asRecord(await response.json());
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const choice = asRecord(choices[0]);
    const msg = asRecord(choice.message);
    const content = asString(msg.content);
    if (!content) return null;
    const parsed = asRecord(JSON.parse(content));
    const action = asString(parsed.accion) as AgentAction;
    const validActions: AgentAction[] = ['respuesta_simple', 'confirmar_pedido', 'pedir_datos', 'listar_productos'];
    if (!validActions.includes(action)) return null;
    return {
      accion: action,
      sku: asString(parsed.sku) || null,
      nombre_cliente: asString(parsed.nombre_cliente) || null,
      direccion: asString(parsed.direccion) || null,
      metodo_pago: asString(parsed.metodo_pago) || null,
      respuesta: asString(parsed.respuesta).slice(0, 700),
    };
  } catch (error) {
    console.error('OpenAI fallback error:', error instanceof Error ? error.message : error);
    return null;
  }
}

function resultFromState(
  accion: AgentAction,
  respuesta: string,
  state: WhatsAppState,
  extras: Partial<AgentResult> = {},
): AgentResult {
  return {
    accion,
    sku: state.last_sku,
    nombre_cliente: state.nombre_cliente,
    direccion: state.direccion,
    metodo_pago: state.metodo_pago,
    respuesta,
    state,
    ...extras,
  };
}

async function miniAgente(
  mensaje: string,
  disponibles: Product[],
  state: WhatsAppState,
  history: ConversationRow[],
): Promise<AgentResult> {
  const parts = splitMessages(mensaje);
  const combined = parts.join(' | ');
  const whole = norm(combined);
  // Send the latest six saved turns as OpenAI chat history on every customer message.
  // Deterministic product, stock and order rules below always take precedence over model output.
  const ai = await askOpenAI(combined, history, state, disponibles);
  const productFromParts = [...parts].reverse().map((part) => findProduct(part, disponibles)).find(Boolean) || null;
  const batchIsOrderOnly = parts.some(isOrderIntent) && !productFromParts;
  const matchedProduct = productFromParts || (!batchIsOrderOnly ? findProduct(combined, disponibles) : null);
  const humanRequest = parts.some(isHumanRequest);

  if (humanRequest) {
    state.paso = 'asesor';
    return resultFromState(
      'respuesta_simple',
      '¡Claro! 😊 Te paso con un asesor para que te ayude personalmente. Dejé marcada tu conversación para atención humana.',
      state,
    );
  }

  const wantsCatalog = parts.some(isListIntent);
  const orderIntent = parts.some(isOrderIntent);
  const howOrder = parts.some((part) => /\b(como hago un pedido|como puedo pedir|como lo pido)\b/.test(norm(part)));
  const inOrderFlow = state.paso === 'capturando';
  const purchaseWithProduct = Boolean(matchedProduct && /\b(quiero|comprar|mandame|mandeme|deme|lo quiero|me lo llevo|pedido)\b/.test(whole));

  if (inOrderFlow || orderIntent || purchaseWithProduct) {
    const product = matchedProduct || disponibles.find((item) => item.sku === state.last_sku) || null;
    if (!product) {
      state.paso = null;
      if (howOrder && disponibles.length) {
        return resultFromState(
          'listar_productos',
          `¡Es fácil! 😊 Elegí un producto del catálogo y escribime *✅ Lo quiero*. Después te pido tu nombre, dirección y forma de pago.\n\n${formatProductList(disponibles.slice(0, 7), disponibles.length)}`,
          state,
          { buttons: catalogButtons() },
        );
      }
      if (disponibles.length) {
        return resultFromState(
          'listar_productos',
          `¡Con gusto! 😊 Primero elegí el producto que querés pedir.\n\n${formatProductList(disponibles.slice(0, 7), disponibles.length)}`,
          state,
          { buttons: catalogButtons() },
        );
      }
      return resultFromState(
        'respuesta_simple',
        '¡Con gusto te ayudo a pedir! 😊 Escribime *Ver catálogo* para elegir el artículo y seguimos con tus datos.',
        state,
        { buttons: catalogButtons() },
      );
    }

    setLastProduct(state, product);
    state.paso = 'capturando';
    for (const part of parts) {
      const isOnlyProductText = Boolean(findProduct(part, disponibles)) &&
        !extractLabelledValue(part, ['mi nombre es', 'nombre completo', 'nombre']) &&
        !extractLabelledValue(part, ['mi direccion es', 'direccion', 'dirección', 'domicilio']) &&
        !isPayment(part);
      if (!isOnlyProductText) applyCustomerData(part, state);
    }
    const missing = missingFields(state);
    if (missing.length) {
      return resultFromState('pedir_datos', promptForMissing(missing), state, { buttons: undefined });
    }
    return resultFromState(
      'confirmar_pedido',
      '',
      state,
      { order: { product, state } },
    );
  }

  if (wantsCatalog) {
    return resultFromState(
      'listar_productos',
      formatProductList(disponibles.slice(0, 7), disponibles.length),
      state,
      { buttons: listButtons() },
    );
  }

  if (matchedProduct) {
    setLastProduct(state, matchedProduct);
    return resultFromState('respuesta_simple', formatProductInfo(matchedProduct), state, { buttons: productButtons() });
  }

  if (parts.some(isGreeting)) {
    const countText = disponibles.length === 1 ? '1 producto disponible' : `${disponibles.length} productos disponibles`;
    return resultFromState(
      'respuesta_simple',
      `¡Holaaa! 😊 Soy Lili de *TodoEnUno SV* 🛍️\nTenemos *${countText}* para vos.\n¿Qué te gustaría ver?`,
      state,
      { buttons: catalogButtons() },
    );
  }

  if (parts.some(isShippingQuestion)) {
    return resultFromState(
      'respuesta_simple',
      '🚚 El envío es *GRATIS* y normalmente llega en *24-72 horas*. Los artículos bajo pedido pueden tardar *3-5 días* en estar listos. 😊',
      state,
      { buttons: catalogButtons() },
    );
  }

  if (parts.some(isPaymentQuestion)) {
    for (const part of parts) {
      const payment = isPayment(part);
      if (payment) state.metodo_pago = payment;
    }
    return resultFromState(
      'respuesta_simple',
      '💳 Podés pagar en *efectivo* o por *transferencia*. Cuando elijás tu producto, te ayudo a dejarlo listo. 😊',
      state,
      { buttons: catalogButtons() },
    );
  }

  if (parts.some((part) => /\b(como hago un pedido|como puedo pedir|como lo pido)\b/.test(norm(part)))) {
    const lastProduct = disponibles.find((product) => product.sku === state.last_sku);
    if (lastProduct) {
      setLastProduct(state, lastProduct);
      state.paso = 'capturando';
      const missing = missingFields(state);
      return resultFromState('pedir_datos', promptForMissing(missing), state);
    }
    return resultFromState(
      'respuesta_simple',
      '¡Es fácil! 😊 Elegí un producto del catálogo y escribime *✅ Lo quiero*. Después te pido tu nombre, dirección y forma de pago.',
      state,
      { buttons: catalogButtons() },
    );
  }

  if (looksLikeProductRequest(combined)) {
    const query = extractProductQuery(combined);
    const alternatives = relatedProducts(query, disponibles, 3);
    if (alternatives.length) {
      const top = alternatives[0];
      setLastProduct(state, top);
      const prefix = norm(top.nombre_completo).includes(norm(query)) || compact(top.nombre_completo).includes(compact(query))
        ? 'Encontré esta opción disponible para vos 😊'
        : 'Ese nombre no me aparece tal cual, pero te comparto una opción real que sí está disponible 😊';
      return resultFromState('respuesta_simple', `${prefix}\n\n${formatProductInfo(top)}`, state, { buttons: productButtons() });
    }
    return resultFromState(
      'respuesta_simple',
      '😊 Estoy actualizando las opciones del catálogo. Escribime *Ver catálogo* o *Asesor* y seguimos.',
      state,
      { buttons: catalogButtons() },
    );
  }

  // Preserve customer details even when the customer sends them before selecting an item.
  let capturedName = false;
  for (const part of parts) {
    if (!state.nombre_cliente && looksLikeName(part)) {
      state.nombre_cliente = part;
      capturedName = true;
    }
    if (extractLabelledValue(part, ['mi direccion es', 'direccion', 'dirección', 'domicilio'])) {
      state.direccion = extractLabelledValue(part, ['mi direccion es', 'direccion', 'dirección', 'domicilio']);
    }
    const payment = isPayment(part);
    if (payment) state.metodo_pago = payment;
  }
  if (capturedName) {
    return resultFromState(
      'respuesta_simple',
      `¡Mucho gusto, ${state.nombre_cliente}! 😊 ¿Qué producto te gustaría ver?`,
      state,
      { buttons: catalogButtons() },
    );
  }

  if (ai?.accion === 'listar_productos') {
    return resultFromState('listar_productos', formatProductList(disponibles.slice(0, 7), disponibles.length), state, { buttons: listButtons() });
  }
  if (ai?.sku) {
    const aiProduct = disponibles.find((product) => product.sku === ai.sku);
    if (aiProduct) {
      setLastProduct(state, aiProduct);
      return resultFromState('respuesta_simple', formatProductInfo(aiProduct), state, { buttons: productButtons() });
    }
  }
  if (ai?.respuesta && ai.accion === 'respuesta_simple') {
    // The model is used only for generic conversation; inventory and order claims stay deterministic.
    return resultFromState('respuesta_simple', ai.respuesta, state, { buttons: catalogButtons() });
  }

  return resultFromState(
    'respuesta_simple',
    '¡Con gusto te ayudo! 😊 Podés ver el catálogo, consultar un producto o pedir que te atienda un asesor.',
    state,
    { buttons: catalogButtons() },
  );
}

async function insertOrder(order: OrderDraft): Promise<void> {
  const { product, state } = order;
  const items = [{
    sku: product.sku,
    nombre: product.nombre_completo,
    precio: product.precio,
    talla: product.talla,
    color: product.color,
    image_url: product.image_url,
    cantidad: 1,
  }];
  await supabaseRequest<unknown>(
    'whatsapp_orders',
    new URLSearchParams(),
    {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{
        telefono: state.telefono,
        nombre: state.nombre_cliente,
        telefono_cliente: state.telefono,
        direccion: state.direccion,
        items,
        total: product.precio,
        estado: 'CONFIRMADO',
        metodo_pago: state.metodo_pago,
      }]),
    },
  );
}

function orderConfirmation(order: OrderDraft): string {
  const { product, state } = order;
  const stockLine = product.inventoryState === 'DISPONIBLE'
    ? '✅ Entrega inmediata'
    : '✨ Disponible bajo pedido (3-5 días)';
  return [
    '✅ *PEDIDO CONFIRMADO* 🎉',
    '',
    `👤 *Nombre:* ${state.nombre_cliente}`,
    `📍 *Dirección:* ${state.direccion}`,
    `📞 *Teléfono:* ${state.telefono}`,
    `💳 *Pago:* ${state.metodo_pago}`,
    '',
    `🛍️ *Producto:* ${product.nombre_completo}`,
    `📦 *Disponibilidad:* ${stockLine}`,
    `💰 *Total:* $${formatPrice(product.precio)}`,
    '',
    '🚚 *Envío GRATIS 24-72h*',
    '¡Gracias por comprar en TodoEnUno SV! 💛',
  ].join('\n');
}

async function sendWhatsApp(numero: string, text: string, buttons?: string[]): Promise<void> {
  if (!EVOLUTION_URL || !EVOLUTION_API_KEY) throw new Error('Missing Evolution API configuration');
  const headers = {
    apikey: EVOLUTION_API_KEY,
    'Content-Type': 'application/json',
    'User-Agent': 'axios/1.13.2',
  };
  const usableButtons = (buttons || []).filter(Boolean).slice(0, 3);
  if (usableButtons.length) {
    try {
      const response = await fetch(
        `${EVOLUTION_URL}/message/sendButtons/${encodeURIComponent(EVOLUTION_INSTANCE)}`,
        {
          method: 'POST',
          cache: 'no-store',
          headers,
          body: JSON.stringify({
            number: numero,
            text,
            footer: 'TodoEnUno SV | Envío Gratis 🚚',
            buttons: usableButtons.map((displayText) => ({ displayText })),
          }),
          signal: AbortSignal.timeout(4000),
        },
      );
      if (response.ok) return;
      const detail = await response.text();
      console.error('Evolution sendButtons failed:', response.status, detail.slice(0, 300));
    } catch (error) {
      console.error('Evolution sendButtons error:', error instanceof Error ? error.message : error);
    }
  }

  const fallbackText = usableButtons.length
    ? `${text}\n\nRespondé con una opción: ${usableButtons.join(' | ')}`
    : text;
  const response = await fetch(
    `${EVOLUTION_URL}/message/sendText/${encodeURIComponent(EVOLUTION_INSTANCE)}`,
    {
      method: 'POST',
      cache: 'no-store',
      headers,
      body: JSON.stringify({ number: numero, text: fallbackText, delay: 800, linkPreview: false }),
      signal: AbortSignal.timeout(4000),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Evolution sendText failed: ${response.status} ${detail.slice(0, 300)}`);
  }
}

async function processBufferedMessage(input: IncomingMessage, combinedText: string): Promise<void> {
  const [state, history, available] = await Promise.all([
    getState(input.telefono).catch((error) => {
      console.error('Could not load WhatsApp state:', error instanceof Error ? error.message : error);
      return newState(input.telefono);
    }),
    loadConversationHistory(input.telefono).catch((error) => {
      console.error('Could not load conversation history:', error instanceof Error ? error.message : error);
      return [] as ConversationRow[];
    }),
    loadAvailableProducts(),
  ]);

  let result = await miniAgente(combinedText, available, state, history);
  let outgoing = result.respuesta;
  let buttons = result.buttons;

  if (result.order) {
    try {
      await insertOrder(result.order);
      result.state.paso = 'confirmado';
      outgoing = orderConfirmation(result.order);
      buttons = undefined;
    } catch (error) {
      console.error('Could not insert WhatsApp order:', error instanceof Error ? error.message : error);
      result.state.paso = 'capturando';
      outgoing = 'Ya tengo tus datos, pero no pude registrar el pedido en este intento. 😊 No hace falta que los escribás otra vez; mandame *confirmar pedido* para intentar de nuevo.';
      buttons = undefined;
    }
  }

  try {
    await saveState(result.state);
  } catch (error) {
    console.error('Could not save WhatsApp state:', error instanceof Error ? error.message : error);
  }

  try {
    await sendWhatsApp(input.numero || input.telefono, outgoing, buttons);
  } catch (error) {
    console.error('Could not send WhatsApp reply:', error instanceof Error ? error.message : error);
  }

  try {
    await saveConversation(input.telefono, combinedText, outgoing);
  } catch (error) {
    console.error('Could not save WhatsApp conversation:', error instanceof Error ? error.message : error);
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, service: 'todoenuno-evolution-webhook' }, { status: 200 });
}

export async function POST(request: Request): Promise<NextResponse> {
  let payload: AnyRecord;
  try {
    payload = asRecord(await request.json());
  } catch {
    return NextResponse.json({ ok: true, ignored: true }, { status: 200 });
  }

  const incoming = extractIncoming(payload);
  if (!incoming) return NextResponse.json({ ok: true, ignored: true }, { status: 200 });

  try {
    await insertBuffer(incoming.telefono, incoming.bufferedText);
    await sleep(BUFFER_DELAY_MS);
    const claimedRows = await claimBufferedMessages(incoming.telefono, new Date().toISOString());
    if (!claimedRows.length) {
      return NextResponse.json({ ok: true, buffered: true }, { status: 200 });
    }
    claimedRows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const combinedText = claimedRows.map((row) => asString(row.mensaje)).filter(Boolean).join(' | ');
    if (combinedText) await processBufferedMessage(incoming, combinedText);
  } catch (error) {
    console.error('Evolution webhook error:', error instanceof Error ? error.message : error);
    // Acknowledge the webhook to avoid Evolution retry storms; inspect Vercel logs for the cause.
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
