import http from "node:http";
http.createServer((q,r)=>{
  if(q.url !== "/metrics"){ r.statusCode=404; return r.end("nope"); }
  r.setHeader("content-type","text/plain");
  r.end(`# HELP keeper_events_total total events
# TYPE keeper_events_total counter
keeper_events_total{kind="ingest"} 42
`);
}).listen(8131, ()=>console.log("keeper dev producer @8131"));
