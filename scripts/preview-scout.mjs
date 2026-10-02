// Review the competitive screen using the already-public monitor data only.
// This preview never supplies a SAR session or exposes SAR operations/financials.
import { createServer } from 'vite';
import { readCompetitive } from '../server/competitive.mjs';
const server = await createServer({ server:{host:'127.0.0.1',port:5174,strictPort:true}, plugins:[{
  name:'scout-public-preview', configureServer(server) {
    server.middlewares.use(async(req,res,next)=>{
      if ((req.url || '').split('?')[0] !== '/__scout-preview-data') return next();
      if(req.method!=='GET'){res.statusCode=405;res.end();return;}
      res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
      try { res.end(JSON.stringify(await readCompetitive(req.url))); }
      catch {res.statusCode=503;res.end(JSON.stringify({error:'Public collection unavailable'}));}
    });
  }
}] });
await server.listen();
console.log('Bingo Scout review: http://127.0.0.1:5174/scout-preview.html');
