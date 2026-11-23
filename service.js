// Cargador fijo del servicio: descarga la versión actual de servicio.js desde
// GitHub y la ejecuta. Así el servicio se puede actualizar sin crear releases.
var https = require('https');
var URL_SERVICIO = 'https://raw.githubusercontent.com/CarmeloSena/senanavarrotv/main/servicio.js?v=' + Date.now();
https.get(URL_SERVICIO, function (res) {
  var codigo = '';
  res.setEncoding('utf8');
  res.on('data', function (t) { codigo += t; });
  res.on('end', function () { new Function('require', 'tizen', codigo)(require, typeof tizen !== 'undefined' ? tizen : undefined); });
}).on('error', function () {});
