// filtra fromMe y grupos
module.exports = async function(){ const body=$input.first().json; if(body.data?.key?.fromMe) return []; return [{json: body}] }