const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
const preferredPort = Number(process.env.PORT || 4173);
const maxPort = preferredPort + 20;

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function serve(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const relativePath = safePath.replace(/^[/\\]+/, "");
  const filePath = path.normalize(path.join(root, relativePath));

  if (filePath !== root && !filePath.startsWith(rootWithSep)) {
    send(res, 403, { "Content-Type": "text/plain; charset=utf-8" }, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
      return;
    }

    send(res, 200, {
      "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "Permissions-Policy": "geolocation=(self)"
    }, data);
  });
}

function listen(port) {
  const server = http.createServer(serve);

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && !process.env.PORT && port < maxPort) {
      listen(port + 1);
      return;
    }

    throw error;
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`fogofwAR map running at http://127.0.0.1:${port}`);
  });
}

listen(preferredPort);
