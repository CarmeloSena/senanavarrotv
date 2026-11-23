// =====================================================================
// SERVICIO DE INICIO FAMILIA (corre dentro de TizenBrew, en la tele)
// Hace de "puente" entre el launcher y el mando interno cifrado de la
// tele (wss://127.0.0.1:8002). El launcher le pide cosas por http:
//   http://127.0.0.1:8095/tecla?k=KEY_HDMI3
//   http://127.0.0.1:8095/app?id=3201907018807
//   http://127.0.0.1:8095/estado
// Escrito en JavaScript "antiguo" porque TizenBrew usa Node.js 4.
// =====================================================================
var http = require('http');
var tls = require('tls');
var crypto = require('crypto');
var fs = require('fs');

var PUERTO = 8095;
var IP_TELE = '192.168.2.119';
var FICHERO_TOKEN = '/home/owner/share/inicioFamiliaToken.txt';
var NOMBRE = new Buffer('Inicio Familia').toString('base64');

var token = '14818075'; // token concedido por la tele a "Inicio Familia" (23/11/2026)
try { token = fs.readFileSync(FICHERO_TOKEN, 'utf8').trim() || token; } catch (e) {}

var socket = null, conectado = false, cola = [], buffer = new Buffer(0);
var estado = 'sin conectar', ultimoMensaje = '';

// ---------- WebSocket mínimo sobre TLS ----------
function conectar() {
  if (socket) return;
  estado = 'conectando';
  var ruta = '/api/v2/channels/samsung.remote.control?name=' + NOMBRE + (token ? '&token=' + token : '');
  var clave = crypto.randomBytes(16).toString('base64');
  var cabeceraRecibida = false;
  buffer = new Buffer(0);

  socket = tls.connect({ host: IP_TELE, port: 8002, rejectUnauthorized: false }, function () {
    socket.write(
      'GET ' + ruta + ' HTTP/1.1\r\n' +
      'Host: ' + IP_TELE + ':8002\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + clave + '\r\n' +
      'Sec-WebSocket-Version: 13\r\n\r\n');
  });

  socket.on('data', function (trozo) {
    buffer = Buffer.concat([buffer, trozo]);
    if (!cabeceraRecibida) {
      var fin = buffer.toString('binary').indexOf('\r\n\r\n');
      if (fin < 0) return;
      var cabecera = buffer.slice(0, fin).toString();
      buffer = buffer.slice(fin + 4);
      if (cabecera.indexOf(' 101 ') < 0) { estado = 'rechazado: ' + cabecera.split('\r\n')[0]; socket.destroy(); return; }
      cabeceraRecibida = true;
      estado = 'abierto (esperando permiso de la tele)';
    }
    leerTramas();
  });

  socket.on('error', function (e) { estado = 'error: ' + e.message; });
  socket.on('close', function () { socket = null; conectado = false; if (estado.indexOf('error') < 0) estado = 'cerrado'; });
}

function leerTramas() {
  while (buffer.length >= 2) {
    var opcode = buffer[0] & 0x0f;
    var largo = buffer[1] & 0x7f, pos = 2;
    if (largo === 126) { if (buffer.length < 4) return; largo = buffer.readUInt16BE(2); pos = 4; }
    else if (largo === 127) { if (buffer.length < 10) return; largo = buffer.readUInt32BE(6); pos = 10; }
    if (buffer.length < pos + largo) return;
    var datos = buffer.slice(pos, pos + largo);
    buffer = buffer.slice(pos + largo);
    if (opcode === 1) recibirTexto(datos.toString('utf8'));
    else if (opcode === 9) enviarTrama(datos, 10); // ping -> pong
    else if (opcode === 8) { socket.destroy(); return; }
  }
}

function recibirTexto(txt) {
  ultimoMensaje = txt.slice(0, 300);
  try {
    var m = JSON.parse(txt);
    if (m.event === 'ms.channel.connect') {
      conectado = true; estado = 'conectado';
      if (m.data && m.data.token) {
        token = m.data.token;
        try { fs.writeFileSync(FICHERO_TOKEN, token); } catch (e) {}
      }
      while (cola.length) enviarTexto(cola.shift());
    } else if (m.event === 'ms.channel.unauthorized') {
      estado = 'la tele ha denegado el permiso';
    }
  } catch (e) {}
}

function enviarTrama(datos, opcode) {
  if (!socket) return;
  var mascara = crypto.randomBytes(4), cab;
  if (datos.length < 126) { cab = new Buffer(2); cab[1] = 0x80 | datos.length; }
  else { cab = new Buffer(4); cab[1] = 0x80 | 126; cab.writeUInt16BE(datos.length, 2); }
  cab[0] = 0x80 | opcode;
  var enmascarado = new Buffer(datos.length);
  for (var i = 0; i < datos.length; i++) enmascarado[i] = datos[i] ^ mascara[i % 4];
  socket.write(Buffer.concat([cab, mascara, enmascarado]));
}

function enviarTexto(txt) { enviarTrama(new Buffer(txt, 'utf8'), 1); }

function mandar(obj) {
  var txt = JSON.stringify(obj);
  if (conectado) enviarTexto(txt); else { cola.push(txt); conectar(); }
}

// ---------- Servidor http para el launcher ----------
http.createServer(function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  var url = require('url').parse(req.url, true), q = url.query;

  if (url.pathname === '/tecla' && q.k) {
    mandar({ method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: q.k, Option: 'false', TypeOfRemote: 'SendRemoteKey' } });
  } else if (url.pathname === '/app' && q.id) {
    mandar({ method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host', data: { appId: q.id, action_type: 'DEEP_LINK' } } });
    // Por si acaso, también por la API sencilla de apps
    ['127.0.0.1', IP_TELE].forEach(function (host) {
      var r = http.request({ host: host, port: 8001, method: 'POST', path: '/api/v2/applications/' + q.id,
        headers: { 'Content-Length': 0, 'Accept': '*/*', 'User-Agent': 'curl/8.7.1' } }, function (resp) {
        var cuerpo = ''; resp.on('data', function (t) { cuerpo += t; });
        resp.on('end', function () { ultimoMensaje = 'App ' + q.id + ' via ' + host + ': HTTP ' + resp.statusCode + ' ' + cuerpo.slice(0, 150); });
      });
      r.on('error', function (e) { ultimoMensaje = 'App ' + q.id + ' via ' + host + ': ' + e.message; });
      r.end();
    });
  } else if (url.pathname === '/conectar') {
    conectar();
  }
  res.end(JSON.stringify({ estado: estado, conectado: conectado, hayToken: !!token, ultimoMensaje: ultimoMensaje }));
}).listen(PUERTO, '127.0.0.1');

conectar();
