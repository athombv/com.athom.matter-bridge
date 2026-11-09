import net from 'node:net';

// Fixed HTTP destination; the isolated SHS container has no outbound route.
net.createServer((client) => {
  const upstream = net.connect(4859, process.env.SHS_ADDRESS);
  client.pipe(upstream).pipe(client);
  client.on('error', () => { upstream.destroy(); });
  upstream.on('error', () => { client.destroy(); });
  client.on('close', () => { upstream.destroy(); });
  upstream.on('close', () => { client.destroy(); });
}).listen(4859, '0.0.0.0');
