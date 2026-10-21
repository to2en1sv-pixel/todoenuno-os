import { createClient } from '@supabase/supabase-js';

// ==================== HELPERS ====================
const norm = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const toks = (s: string) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);
const DEPTOS = ["Ahuachapan","Santa Ana","Sonsonate","Chalatenango","La Libertad","San Salvador","Cuscatlan","La Paz","Cabanas","San Vicente","Usulutan","San Miguel","Morazan","La Union"];
const getKey = (jid: string) => jid.split('@')[0].replace(/\D/g,'').slice(-11);

// ==================== CONFIG - SOLO CAMBIAS ESTO ====================
const CONFIG = {
  SALUDO: `¡Hola! Tengo 91 productos. Escribe "porta bebes"`,
  PRECIO_DEFECTO: 15
};

// ==================== DB ANTI-LOOP ====================
async function getState(supa: any, k: string) {
  const { data } = await supa.from('whatsapp_state').select('*').eq('telefono', k).limit(1).maybeSingle();
  return data;
}
async function saveState(supa: any, k: string, updates: any) {
  const existing = await getState(supa, k);
  const merged = { ...(existing || {}), ...updates, telefono: k };
  await supa.from('whatsapp_state').delete().eq('telefono', k);
  await supa.from('whatsapp_state').insert(merged);
}

// ==================== AGENTE 1.5: LISTA BLANCA ====================
function esProductoReal(raw: string, vars: any[]) {
  if (!vars?.length) return false;
  const n = norm(raw);
  if (n.length < 4) return false;
  const keywords = vars.map((v: any) => norm(v.nombre_completo || ''));
  return keywords.some((k: string) => n.includes(k.split(' ')[0]) && k.includes(n.split(' ')[0]) || k.includes(n) || n.includes(k));
}
function validarSegunEntidad(entidad: string, valor: string) {
  const t = valor.trim();
  if (entidad === 'PERSONA') {
    if (t.length < 2) return { ok: false, msg: '❌ Dame tu nombre Ej: Carlos Sorto' };
    return { ok: true, val: t };
  }
  if (entidad === 'TELEFONO') {
    const num = t.replace(/\D/g, '').slice(-8);
    if (
