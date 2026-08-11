import https from "node:https";
import mod from "./packages/network/dist/transport/tls.js";

const { key, cert } = await mod.generateSelfSignedCert({ deviceId: "kbm-desktop" });
const c = new (await import("node:crypto")).X509Certificate(cert);
console.log("parsed OK:", c.subject, "|", c.validTo);
console.log("fp:", mod.fingerprintOf(cert));
console.log("deviceIdOf:", mod.deviceIdOf(cert));

const srv = https.createServer({ key, cert }, (req, res) => {
  res.end("ok");
});
srv.listen(0, "127.0.0.1", () => {
  const port = srv.address().port;
  console.log("listening on", port);
  const req = https.request(
    { port, host: "127.0.0.1", method: "GET", rejectUnauthorized: false },
    (res) => {
      console.log("TLS OK");
      srv.close();
      process.exit(0);
    },
  );
  req.on("error", (e) => {
    console.log("request error:", e.message);
    srv.close();
    process.exit(1);
  });
  req.end();
});
srv.on("tlsClientError", (err) => {
  console.log("TLS CLIENT ERROR:", err.message);
});
srv.on("keylog", (line) => console.log("keylog:", line.slice(0, 30)));
setTimeout(() => {
  console.log("TIMEOUT");
  srv.close();
  process.exit(2);
}, 10000);
