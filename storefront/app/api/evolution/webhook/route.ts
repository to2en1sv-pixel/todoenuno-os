// AGENTE 3: Checkout ESTRICTO - valida todo antes de cerrar
const DEPARTAMENTOS_SV = ["Ahuachapan","Santa Ana","Sonsonate","Chalatenango","La Libertad","San Salvador","Cuscatlan","La Paz","Cabanas","San Vicente","Usulutan","San Miguel","Morazan","La Union"];

function validarNombre(n:string){
  const t=n.trim();
  if(t.split(' ').filter(w=>w.length>=2).length < 2) return {ok:false, msg:"❌ Escribí tu *nombre completo* Ej: Cristian Castro"};
  if(!/^[A-Za-zÁÉÍÓÚáéíóúÑñ ]{5,50}$/.test(t)) return {ok:false, msg:"❌ Solo letras por favor Ej: Cristian Castro"};
  return {ok:true, val:t};
}
function validarTelefono(n:string){
  const num=n.replace(/\D/g,'').slice(-8);
  if(num.length!==8) return {ok:false, msg:"❌ Teléfono debe ser 8 dígitos Ej: 77974768"};
  if(!/^[67]\d{7}$/.test(num)) return {ok:false, msg:"❌ En El Salvador empieza con 6 o 7 Ej: 77974768"};
  return {ok:true, val:num};
}
function validarDepto(n:string){
  const clean=norm(n).replace(/[^a-z]/g,'');
  const found=DEPARTAMENTOS_SV.find(d=>norm(d).replace(/[^a-z]/g,'')===clean || norm(d).includes(clean) || clean.includes(norm(d).replace(/[^a-z]/g,'')));
  if(!found) return {ok:false, msg:`❌ Departamento no válido. Debe ser uno de: ${DEPARTAMENTOS_SV.join(', ')}`};
  return {ok:true, val:found};
}
function validarMunicipio(n:string){
  const t=n.trim();
  if(t.length<3) return {ok:false, msg:"❌ Municipio muy corto Ej: Soyapango"};
  if(/^\d+$/.test(t)) return {ok:false, msg:"❌ Municipio no puede ser solo números"};
  return {ok:true, val:t};
}
function validarDireccion(n:string){
  const t=n.trim();
  if(t.length<10) return {ok:false, msg:"❌ Dirección muy corta. Pon calle, colonia, # de casa Ej: Colonia Las Flores, calle principal #12"};
  return {ok:true, val:t};
}

async function checkoutFlow(supa:any, state:any, prod:any, jid:string, rawInput:string){
  const p=prod||{nombre_completo:state?.last_nombre||'Producto', precio:state?.last_precio||15, talla:state?.last_talla, color:state?.last_color};
  
  // determina en qué paso estamos
  const pasoActual = state?.paso?.startsWith('collecting_') ? state.paso.replace('collecting_','') : null;
  const falta=!state?.nombre_cliente?'nombre':!state?.telefono_cliente?'telefono':!state?.departamento?'departamento':!state?.municipio?'municipio':!state?.direccion?'direccion':null;

  // si estamos colectando, validamos el dato que acaba de mandar
  if(pasoActual){
    let v:any={ok:false};
    if(pasoActual==='nombre') v=validarNombre(rawInput);
    if(pasoActual==='telefono') v=validarTelefono(rawInput);
    if(pasoActual==='departamento') v=validarDepto(rawInput);
    if(pasoActual==='municipio') v=validarMunicipio(rawInput);
    if(pasoActual==='direccion') v=validarDireccion(rawInput);
    
    if(!v.ok){
      return v.msg; // se queda en el mismo paso, no avanza
    }else{
      const col=pasoActual==='nombre'?'nombre_cliente':pasoActual==='telefono'?'telefono_cliente':pasoActual;
      await supa.from('whatsapp_state').upsert({telefono:jid,[col]:v.val,paso:'idle'},{onConflict:'telefono'});
      const {data:st2}=await supa.from('whatsapp_state').select('*').eq('telefono',jid).single();
      state=st2;
    }
  }

  // calcula que falta AHORA después de validar
  const faltaAhora=!state?.nombre_cliente?'nombre':!state?.telefono_cliente?'telefono':!state?.departamento?'departamento':!state?.municipio?'municipio':!state?.direccion?'direccion':null;

  if(faltaAhora){
    const msgs:any={
      nombre:`✅ Producto: *${p.nombre_completo}* $${p.precio} | ${p.talla||''} ${p.color||''}\n\n1️⃣ Para apartarlo necesito tu *nombre completo* (nombre y apellido) ✨`,
      telefono:`2️⃣ Perfecto ${state.nombre_cliente}. Ahora tu *teléfono de 8 dígitos* que empiece con 6 o 7 📱 Ej: 77974768`,
      departamento:`3️⃣ ¿De qué *departamento* sos? Ej: San Salvador\nVálidos: ${DEPARTAMENTOS_SV.join(', ')}`,
      municipio:`4️⃣ ¿Tu *municipio*? Ej: Soyapango`,
      direccion:`5️⃣ Último paso: *Dirección exacta* con colonia, calle, # casa y punto de referencia 📍\nEj: Colonia Escalón, calle X #12, frente a farmacia`
    };
    await supa.from('whatsapp_state').upsert({telefono:jid,paso:`collecting_${faltaAhora}`},{onConflict:'telefono'});
    return msgs[faltaAhora];
  }else{
    // TODO VALIDADO - recién ahí cierra pedido
    await supa.from('whatsapp_orders').insert({
      telefono:jid,
      nombre:state.nombre_cliente,
      telefono_cliente:state.telefono_cliente,
      departamento:state.departamento,
      municipio:state.municipio,
      direccion:state.direccion,
      items:[p],
      total:p.precio,
      estado:'nuevo'
    });
    await supa.from('whatsapp_state').upsert({telefono:jid,paso:'confirmado'},{onConflict:'telefono'});
    return `✅ *PEDIDO CONFIRMADO - DATOS COMPLETOS* ✅\n\n🛍️ *${p.nombre_completo}*\n🎨 ${p.talla||'Única'} | ${p.color||''}\n💰 *$${p.precio}*\n👤 *${state.nombre_cliente}*\n📱 *${state.telefono_cliente}*\n📍 *${state.departamento}, ${state.municipio}*\n🏠 ${state.direccion}\n\n🚚 Te contactamos en menos de 2h para coordinar entrega 3-5 días.\n¿Algo más que quieras agregar?`;
  }
}
