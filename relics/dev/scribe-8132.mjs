import http from "node:http";
http.createServer((q,r)=>{
  if(q.url !== "/metrics"){ r.statusCode=404; return r.end("nope"); }
  r.setHeader("content-type","text/plain");
  r.end(`# HELP scribe_batches_total total batches
# TYPE scribe_batches_total counter
scribe_batches_total 7
`);
}).listen(8132, ()=>console.log("scribe dev producer @8132"));
